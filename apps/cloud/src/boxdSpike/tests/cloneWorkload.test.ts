// @effect-diagnostics nodeBuiltinImport:off - This test executes the exact Python workload as a local subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { CLONE_WORKLOAD } from "../cloneWorkload.ts";

it("the real Python guard clears cloned memory and copied config before accepting a new lease", async () => {
  const verify = String.raw`
import copy, json, pathlib, tempfile, types
from unittest.mock import patch
scope = {'__name__': 'fixture'}
exec(${JSON.stringify(CLONE_WORKLOAD)}, scope)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    with patch('os.uname', return_value=types.SimpleNamespace(nodename='source')):
        source = scope['Guard'](root)
        assert source.tick()['leasePresent']
        clone = copy.deepcopy(source)
    (root / 'config.json').write_text(json.dumps({'identity':'source','generation':'source'}))
    with patch('os.uname', return_value=types.SimpleNamespace(nodename='clone')):
        state = clone.tick()
        assert state['waiting'] and not state['leasePresent'] and state['cleared']
        assert not (root / 'config.json').exists() and state['reconnects'] == 0
        (root / 'config.json').write_text(json.dumps({'identity':'source','generation':'child'}))
        assert clone.tick()['waiting']
        (root / 'config.json').write_text(json.dumps({'identity':'clone','generation':'child'}))
        state = clone.tick()
        assert state['leasePresent'] and not state['waiting'] and state['reconnects'] == 1
        assert clone.tick()['reconnects'] == 1
print('clone guard passed')
`;
  const result = await NodeUtil.promisify(NodeChildProcess.execFile)("python3", ["-c", verify]);
  expect(result.stdout.trim()).toBe("clone guard passed");
});
