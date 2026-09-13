// Program.cs - the entry point, the command line of docs/WORKERS.md section 1.1, and the stdio
// request loop of section 1.
//
// Command line:
//   vmltext --capability <text.normalize|text.extract|text.fingerprint>
//   vmltext --selfcheck
//
// Anything else is an error on stderr with exit 2, and a missing or unknown capability is the same,
// because the host launches one worker per capability and a wiring mistake should be loud.
//
// Three Windows/stdio traps are handled here and nowhere else:
//
//   * **Encoding.** All three streams are UTF-8 bytes on every platform (docs/WORKERS.md section
//     1.2). On a Chinese Windows the console defaults to GBK, so a worker that reads through
//     Console.In or writes through Console.Out turns the contract's text into mojibake while still
//     looking like it works. This worker opens the raw standard streams and reads/writes UTF-8
//     bytes; the process's own input/output encodings are set to UTF-8 *without* a BOM. A BOM on the
//     first line of either direction would break parsing, and a redirected stdout is exactly where
//     .NET would otherwise be happy to add one.
//
//   * **Buffering.** "Flush stdout after every response line, before reading the next request."
//     Console.Out buffers, and a worker that answers correctly into a buffer answers NOTHING: the
//     host shows a timeout, not a buffering problem. This worker writes each line to the stream and
//     flushes it before it reads again (JsonOut.WriteLineTo).
//
//   * **Line endings and long lines.** The transport is LF, and a corpus case is a 10 KB HTML
//     document on ONE line. The loop below therefore reads descriptor bytes itself rather than going
//     through StreamReader.ReadLine: a reader for a line-oriented protocol on a pipe must not hold a
//     partial line in a block buffer while the host waits for the answer. (That is the second half of
//     the trap that broke the first C++ worker: its flushes were correct and its buffered fread was
//     not, so it answered nothing while `echo ... | worker` looked perfect.) A trailing CR is
//     stripped so a CR LF producer is tolerated; every response ends with a single LF.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Vml;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception error)
        {
            // Last-resort reporting: a stack trace on stdout would be protocol traffic and would be
            // read as an unparsable line, so everything unexpected goes to stderr and exits non-zero.
            try
            {
                Console.Error.WriteLine("error: unexpected " + error.GetType().Name + ": " + error.Message);
                Console.Error.Flush();
            }
            catch (IOException)
            {
                // stderr is gone too; the exit code is all that is left to report with.
            }

            return 1;
        }
    }

    private static int Run(string[] args)
    {
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false);

        // Set the process's stream encodings before anything else touches them. This is what keeps a
        // file or pipe redirection from picking up the system code page, and the explicit `false` for
        // the BOM is the difference between "the first line parses" and "every first line fails".
        Console.InputEncoding = utf8;
        Console.OutputEncoding = utf8;

        string capability = string.Empty;
        bool selfCheck = false;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--selfcheck":
                    selfCheck = true;
                    break;
                case "--capability":
                    if (i + 1 >= args.Length)
                    {
                        Console.Error.WriteLine("error: --capability requires a capability name");
                        return 2;
                    }

                    capability = args[i + 1];
                    i++;
                    break;
                default:
                    Console.Error.WriteLine($"error: unrecognised argument \"{args[i]}\"; usage: vmltext --capability <name>|--selfcheck");
                    return 2;
            }
        }

        SpecTables tables;
        try
        {
            tables = SpecTables.Load(SpecTables.FindSpecDirectory());
        }
        catch (SpecTableException error)
        {
            // Without the shared tables there is nothing to run: the contract's tables are the rule,
            // and falling back to .NET's Unicode data would produce a worker that is wrong exactly
            // where it matters.
            Console.Error.WriteLine("error: " + error.Message);
            Console.Error.WriteLine("error: set VML_SPEC_DIR to the directory holding latin-lower.json and latin-fold.json");
            return 2;
        }

        var protocol = new Protocol(tables, Protocol.RuntimeString());

        if (selfCheck)
        {
            Stream selfCheckOut = Console.OpenStandardOutput();
            return new SelfCheck(protocol).Run(selfCheckOut);
        }

        if (capability.Length == 0)
        {
            Console.Error.WriteLine("error: --capability <name> is required; usage: vmltext --capability <name>|--selfcheck");
            return 2;
        }

        if (!Protocol.IsKnownCapability(capability))
        {
            Console.Error.WriteLine($"error: unknown capability \"{capability}\"; this artifact implements {Protocol.CapabilityList()}");
            return 2;
        }

        return Serve(protocol, capability);
    }

    /// <summary>
    /// The request loop. A malformed line is answered with ok:false and the loop keeps going ("ok:false
    /// is a normal answer"); a shutdown line is answered with the bare envelope and ends the loop; a
    /// closed stdout ends it too, because nothing can be reported any more.
    /// </summary>
    private static int Serve(Protocol protocol, string capability)
    {
        Stream stdout = Console.OpenStandardOutput();
        Stream stderr = Console.OpenStandardError();

        // A descriptor read rather than StreamReader.ReadLine, and deliberately so: a line-oriented
        // protocol on a pipe must never hold a partial line in a block buffer while the host waits
        // for the answer. (That is the second half of the trap that broke the first C++ worker: its
        // flushes were correct and its buffered fread was not, so it answered nothing at all while
        // `echo ... | worker` looked perfect.)
        using Stream input = Console.OpenStandardInput();
        var line = new List<byte>(256);
        var chunk = new byte[8192];

        var writer = new JsonOut();
        while (true)
        {
            int count = input.Read(chunk, 0, chunk.Length);
            if (count <= 0)
            {
                if (line.Count > 0)
                {
                    // A last line without its LF: answer it rather than dropping it.
                    bool answered = HandleLine(protocol, capability, line.ToArray(), writer, stdout, stderr, out bool stopAtEof);
                    if (!answered || stopAtEof)
                    {
                        return 0;
                    }
                }

                return 0;
            }

            int at = 0;
            while (at < count)
            {
                int index = Array.IndexOf(chunk, (byte)'\n', at, count - at);
                if (index < 0)
                {
                    AppendRange(line, chunk, at, count - at);
                    break;
                }

                AppendRange(line, chunk, at, index - at);
                if (line.Count > 0 && line[^1] == (byte)'\r')
                {
                    // CR LF: the CR is part of the ending, not part of the line.
                    line.RemoveAt(line.Count - 1);
                }

                byte[] bytes = line.ToArray();
                line.Clear();
                if (!HandleLine(protocol, capability, bytes, writer, stdout, stderr, out bool stop))
                {
                    return 0;
                }

                if (stop)
                {
                    return 0;
                }

                at = index + 1;
            }
        }
    }

    private static void AppendRange(List<byte> target, byte[] source, int start, int length)
    {
        for (int i = 0; i < length; i++)
        {
            target.Add(source[start + i]);
        }
    }

    /// <summary>
    /// Answers one request line. Returns false when stdout is gone and the loop must end;
    /// <paramref name="shutdown"/> reports that the line was a shutdown and the worker should exit 0.
    /// </summary>
    private static bool HandleLine(
        Protocol protocol,
        string capability,
        byte[] bytes,
        JsonOut writer,
        Stream stdout,
        Stream stderr,
        out bool shutdown)
    {
        shutdown = false;
        if (bytes.Length == 0 || IsAllWhitespace(bytes))
        {
            // A blank line is not a request object; answer without an id rather than dying.
            Protocol.WriteNullIdError(writer, "bad-input", "request line is empty");
            return TryWrite(writer, stdout, stderr);
        }

        Protocol.RequestShape? request = Protocol.ParseLine(bytes, out string? failure);
        if (request == null)
        {
            Protocol.WriteNullIdError(writer, "bad-input", failure ?? "request is not a JSON object");
            return TryWrite(writer, stdout, stderr);
        }

        Protocol.RequestShape shape = request.Value;
        if (!shape.HasOp)
        {
            Protocol.WriteError(writer, shape.IdToken, "bad-input", "request.op must be a string");
            return TryWrite(writer, stdout, stderr);
        }

        if (shape.Op == "shutdown")
        {
            // The contract shows {"id":<id>,"ok":true} for shutdown and nothing more; that is what
            // this worker answers, and it is the last line it writes.
            Protocol.WriteShutdownAck(writer, shape.IdToken);
            shutdown = true;
            return TryWrite(writer, stdout, stderr);
        }

        if (shape.Op == "describe")
        {
            protocol.WriteDescribe(writer, shape.IdToken, capability);
            return TryWrite(writer, stdout, stderr);
        }

        if (shape.Op == "invoke")
        {
            protocol.WriteInvoke(writer, shape.IdToken, capability, shape.HasCapability, shape.RequestedCapability, shape.Input);
            return TryWrite(writer, stdout, stderr);
        }

        Protocol.WriteError(writer, shape.IdToken, "unsupported", "unknown op " + shape.Op);
        return TryWrite(writer, stdout, stderr);
    }

    private static bool IsAllWhitespace(byte[] bytes)
    {
        foreach (byte b in bytes)
        {
            if (b != (byte)' ' && b != (byte)'\t' && b != (byte)'\r' && b != (byte)'\n')
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryWrite(JsonOut writer, Stream stdout, Stream stderr)
    {
        try
        {
            writer.WriteLineTo(stdout);
            return true;
        }
        catch (IOException error)
        {
            // The host closed the pipe: report on stderr (which may also be gone) and stop rather than
            // spinning on a stream nobody is reading.
            try
            {
                Console.Error.WriteLine("error: cannot write to stdout: " + error.Message);
                Console.Error.Flush();
            }
            catch (IOException)
            {
                // Nothing left to do.
            }

            return false;
        }
    }
}
