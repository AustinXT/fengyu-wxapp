#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const canonicalPath = path.join(root, 'envs/prod.env.example')

function keys(file) {
  const text = fs.readFileSync(file, 'utf8')
  const result = [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1])
  const duplicates = result.filter((key, index) => result.indexOf(key) !== index)
  if (duplicates.length) throw new Error(`${path.relative(root, file)} has duplicate keys: ${[...new Set(duplicates)].join(', ')}`)
  return result
}

const canonical = keys(canonicalPath)
const candidates = [
  'envs/dev.env.example',
  'envs/prod.env',
  'envs/dev.env',
]

for (const relative of candidates) {
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) continue
  const actual = keys(file)
  if (actual.join('\n') !== canonical.join('\n')) {
    const missing = canonical.filter((key) => !actual.includes(key))
    const extra = actual.filter((key) => !canonical.includes(key))
    throw new Error(`${relative} is not aligned with envs/prod.env.example (missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'})`)
  }
}

console.log(`Environment structure aligned: ${canonical.length} keys.`)
