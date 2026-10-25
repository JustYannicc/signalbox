/** Proof-only native fence. SDK request cancellation cannot fence a delayed provider exec. */
export const BOXD_PROOF_LAUNCH_FENCE = String.raw`
import fcntl, json, os, stat, sys, time

def directory(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    value = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or os.path.realpath(path) != path:
        raise RuntimeError("noncanonical launch fence directory")

def lock_fence(path):
    directory(path)
    fd = os.open(path + "/launch.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise RuntimeError("invalid launch fence lock")
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd

def close_fence(path):
    fd = os.open(path + "/closed", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, b"closed\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)

def launch(fence, cgroup, command):
    lock = lock_fence(fence)
    try:
        if os.path.lexists(fence + "/closed"):
            raise RuntimeError("launch is permanently fenced")
        os.makedirs(cgroup, exist_ok=True)
        if os.path.realpath(cgroup) != cgroup:
            raise RuntimeError("noncanonical command cgroup")
        reader, writer = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(reader)
                os.setsid()
                # Redirect all SDK pipes before acknowledging detachment.
                null = os.open(os.devnull, os.O_RDWR)
                for fd in (0, 1, 2):
                    os.dup2(null, fd)
                if null > 2 and null != writer:
                    os.close(null)
                maximum = os.sysconf("SC_OPEN_MAX")
                os.closerange(3, writer)
                os.closerange(writer + 1, maximum)
                with open(cgroup + "/cgroup.procs", "w") as group:
                    group.write(str(os.getpid()))
                # The parent retains the lock until membership is established.
                os.write(writer, b"1")
                os.close(writer)
                os.execv(command[0], command)
            except BaseException:
                os._exit(125)
        os.close(writer)
        try:
            joined = os.read(reader, 1)
        finally:
            os.close(reader)
        if joined != b"1":
            os.waitpid(pid, 0)
            raise RuntimeError("native child did not join the cgroup")
        return {"launched": True, "joined": True}
    finally:
        os.close(lock)

def quiesce(fence, cgroup):
    lock = lock_fence(fence)
    try:
        close_fence(fence)
        if not os.path.lexists(cgroup):
            # A setup arriving later sees the durable closed marker under this same lock.
            return {"closed": True, "populated": 0, "launchFenced": True}
        if os.path.realpath(cgroup) != cgroup or not stat.S_ISDIR(os.lstat(cgroup).st_mode):
            raise RuntimeError("noncanonical command cgroup")
        with open(cgroup + "/cgroup.kill", "w") as kill:
            kill.write("1")
        for attempt in range(200):
            with open(cgroup + "/cgroup.events") as events:
                values = dict(line.split() for line in events)
            if values.get("populated") == "0":
                return {"closed": True, "populated": 0, "launchFenced": True}
            time.sleep(0.05)
        raise RuntimeError("command cgroup remains populated")
    finally:
        os.close(lock)

if __name__ == "__main__":
    mode, fence, cgroup = sys.argv[1:4]
    if mode == "launch":
        result = launch(fence, cgroup, sys.argv[4:])
    elif mode == "quiesce":
        result = quiesce(fence, cgroup)
    else:
        raise RuntimeError("unsupported proof fence operation")
    print(json.dumps(result, separators=(",", ":")))
`;
