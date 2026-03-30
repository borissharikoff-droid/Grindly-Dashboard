const fs = require('fs')
const html = fs.readFileSync('public/index.html', 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/g)
const code = m[0].replace(/<\/?script>/g, '')
const re = /\b(const|let)\s+(\w+)/g
const seen = {}
let match
while ((match = re.exec(code)) !== null) {
  const name = match[2]
  const line = code.substring(0, match.index).split('\n').length
  if (seen[name]) {
    console.log('DUP: ' + match[1] + ' ' + name + ' lines ' + seen[name] + ',' + line)
  } else {
    seen[name] = line
  }
}
