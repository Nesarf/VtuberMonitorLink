// workers/java/tools/probe-search-cases.mjs — development probe: run one JSON array of search inputs
// through the JavaScript reference and print what it answers, so a self-check expectation can be
// pinned against something other than an assumption. Not a shipped test.
//
//   node workers/java/tools/probe-search-cases.mjs '[{"docs":[],"query":{}}]'
import { search } from '../../js/vmlsearch.js';

const inputs = JSON.parse(process.argv[2]);
for (const input of inputs) {
  console.log(JSON.stringify(input));
  try {
    console.log('  => ' + JSON.stringify(search(input)));
  } catch (e) {
    console.log('  => error ' + e.code + ': ' + e.message);
  }
}
