import { Database } from "bun:sqlite"
const db = new Database(`${process.env.USERPROFILE}\\.local\\share\\opencode\\opencode.db`, { readonly: true })
const rows = db.query("select data from session_message where type='compaction' order by time_created desc limit 200").all() as any[]
const isOurs = (s?: string) => !!s && (s.includes("[Session Goal]") || s.includes("## Observations") || s.includes("blackhole_recall"))
let n = 0
for (const r of rows) {
  const d = JSON.parse(r.data); if (!isOurs(d.summary)) continue
  const sections = d.summary.split("\n\n---\n\n")[0]
  console.log("---", (d.summary.length/4000).toFixed(1)+"kTok")
  for (const line of sections.split("\n")) if (/^\[|^## |^-?\s*$/.test(line)) console.log("   ", line.slice(0,80))
  if (++n >= 3) break
}
db.close()
