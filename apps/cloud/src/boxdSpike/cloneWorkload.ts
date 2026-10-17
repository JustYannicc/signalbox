/** No network calls or real credentials. The live process must survive hibernate and fork. */
export const CLONE_WORKLOAD = String.raw`
import json, os, pathlib, time

class Guard:
    def __init__(self, root):
        self.root = root
        self.birth = os.uname().nodename
        self.identity = self.birth
        self.lease = 'source-sentinel'
        self.waiting = False
        self.reconnects = 1
        self.cleared = False
        self.config_removed = False

    def tick(self):
        observed = os.uname().nodename
        config = self.root / 'config.json'
        if observed != self.identity:
            self.lease = None
            self.waiting = True
            self.reconnects = 0
            self.cleared = True
            config.unlink(missing_ok=True)
            self.config_removed = True
            self.identity = observed
        if self.waiting and config.exists():
            candidate = json.loads(config.read_text())
            if candidate.get('identity') == observed and candidate.get('generation') == 'child':
                self.lease = 'child-sentinel'
                self.waiting = False
                self.reconnects += 1
                config.unlink()
        return dict(pid=os.getpid(), birth=self.birth, observed=observed,
                    waiting=self.waiting, leasePresent=self.lease is not None,
                    cleared=self.cleared, configRemoved=self.config_removed,
                    reconnects=self.reconnects)

if __name__ == '__main__':
    root = pathlib.Path('/tmp/signalbox-boxd-spike')
    guard = Guard(root)
    while True:
        tmp = root / 'status.tmp'
        tmp.write_text(json.dumps(guard.tick()))
        tmp.replace(root / 'status.json')
        time.sleep(0.1)
`;
