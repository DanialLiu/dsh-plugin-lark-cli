// Starts a hanging child through Runner, reports its pid, then exits at once WITHOUT disposing the runner.
import { Runner } from '../../src/runner.ts'
const runner = new Runner()
runner.start(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 60_000, onLine: () => {} })
await new Promise(r => setTimeout(r, 500))
console.log(`CHILD_COUNT ${runner.active}`)
process.exit(0)
