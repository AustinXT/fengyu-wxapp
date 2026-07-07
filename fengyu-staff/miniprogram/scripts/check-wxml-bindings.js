#!/usr/bin/env node


const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP_JSON = path.join(ROOT, 'app.json')



function getAllPages() {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8'))
  const pages = [...(appJson.pages || [])]
  for (const sub of appJson.subPackages || []) {
    for (const p of sub.pages || []) {
      pages.push(`${sub.root}/${p}`)
    }
  }
  return pages
}



function extractWxmlHandlers(wxmlContent) {
  const handlers = new Set()
  
  
  const re = /(?:bind:|catch:|mut-bind:|bind|catch)[\w-]+=["'](\w+)["']/g
  let m
  while ((m = re.exec(wxmlContent)) !== null) {
    handlers.add(m[1])
  }
  return handlers
}



function extractPageMethods(tsContent) {
  const methods = new Set()

  
  
  
  
  
  const re = /^ {2}(?:async\s+)?(\w+)\s*[\(:{,]/gm
  let m
  while ((m = re.exec(tsContent)) !== null) {
    methods.add(m[1])
  }

  return methods
}



function check() {
  const pages = getAllPages()
  let errors = 0
  let checked = 0
  let totalHandlers = 0

  for (const page of pages) {
    const wxmlPath = path.join(ROOT, page + '.wxml')
    const tsPath = path.join(ROOT, page + '.ts')

    if (!fs.existsSync(wxmlPath)) continue
    if (!fs.existsSync(tsPath)) continue

    const wxmlContent = fs.readFileSync(wxmlPath, 'utf-8')
    const tsContent = fs.readFileSync(tsPath, 'utf-8')

    const handlers = extractWxmlHandlers(wxmlContent)
    const methods = extractPageMethods(tsContent)

    checked++
    totalHandlers += handlers.size

    for (const handler of handlers) {
      if (!methods.has(handler)) {
        console.error(`ERROR: ${page}.wxml binds "${handler}" but ${page}.ts has no such method`)
        errors++
      }
    }
  }

  console.log(`\nChecked ${checked} pages, ${totalHandlers} handler bindings`)

  if (errors > 0) {
    console.error(`\n${errors} binding error(s) found!`)
    process.exit(1)
  } else {
    console.log('All WXML handler bindings are valid.')
  }
}

check()
