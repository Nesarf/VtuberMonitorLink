package vml;

import java.util.List;
import java.util.Map;
import java.util.Set;

/** Scratch: what the index actually holds for a CJK tag case. */
public final class ScratchTag {
    private ScratchTag() {
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        Map<String, Object> input = (Map<String, Object>) Json.parse(
                "{\"docs\":[{\"id\":\"a\",\"title\":\"\",\"text\":\"\",\"tags\":[\"经开\",\"开播\"],\"ts\":null}],"
                        + "\"query\":{\"terms\":[\"经开开播\"]},\"limit\":0}");
        @SuppressWarnings("unchecked")
        List<Object> docs = (List<Object>) input.get("docs");
        Search.Index index = Search.buildIndex(docs);

        System.out.println("doc tags verbatim      = " + index.tags.get(0));
        List<Set<String>> perTag = index.tagTokenSets.get(0);
        for (int i = 0; i < perTag.size(); i++) {
            System.out.println("tag[" + i + "] token set     = " + perTag.get(i));
        }
        System.out.println("tokensOf(经开开播)      = " + Tokenizer.tokensOf("\u7ecf\u5f00\u5f00\u64ad"));
        System.out.println("tokensOf(经开)          = " + Tokenizer.tokensOf("\u7ecf\u5f00"));
        System.out.println("tokensOf(开播)          = " + Tokenizer.tokensOf("\u5f00\u64ad"));
        System.out.println("containsAll(经开开播)   = " + perTag.get(0).containsAll(Tokenizer.tokensOf("\u7ecf\u5f00\u5f00\u64ad")));
        System.out.println("answer                 = " + Json.encode(Search.query(input)));
    }
}
