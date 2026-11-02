import fs from "node:fs";
export function acquirePublisher(file: string): (() => void) | null {
  const lock = file + ".publisher";
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") return null;
    try {
      const stat = fs.lstatSync(lock);
      if (!stat.isFile()) return null;
      const pid = Number(fs.readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      try {
        process.kill(pid, 0);
        return null;
      } catch (error) {
        if (error.code !== "ESRCH") return null;
      }
      if (fs.lstatSync(lock).ino !== stat.ino) return null;
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch {
      return null;
    }
  }
  const inode = fs.lstatSync(lock).ino;
  return () => {
    try {
      if (
        fs.lstatSync(lock).ino === inode &&
        fs.readFileSync(lock, "utf8") === String(process.pid)
      )
        fs.unlinkSync(lock);
    } catch {}
  };
}
