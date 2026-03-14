#!/usr/bin/env node
/**
 * WXML 绑定静态检查
 * 扫描所有页面的 .wxml 文件，提取事件 handler 引用，
 * 与对应 .ts 文件中的 Page() 方法声明交叉校验。
 *
 * 用法：node scripts/check-wxml-bindings.js
 * 退出码：0 = 通过, 1 = 有错误
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP_JSON = path.join(ROOT, 'app.json')

// ————— 从 app.json 收集所有页面路径 —————

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

// ————— 从 WXML 中提取事件 handler 名称 —————

function extractWxmlHandlers(wxmlContent) {
  const handlers = new Set()
  // bind:xxx="handler"  bindxxx="handler"  catch:xxx="handler"  catchxxx="handler"
  // mut-bind:xxx="handler"
  const re = /(?:bind:|catch:|mut-bind:|bind|catch)[\w-]+=["'](\w+)["']/g
  let m
  while ((m = re.exec(wxmlContent)) !== null) {
    handlers.add(m[1])
  }
  return handlers
}

// ————— 从 TS 中提取 Page({ ... }) 的方法名 —————

function extractPageMethods(tsContent) {
  const methods = new Set()

  // 匹配 Page() 内的方法定义，支持：
  //   methodName(           — 普通方法
  //   async methodName(     — async 方法
  //   methodName:           — 属性简写
  //   methodName,           — 单行属性
  const re = /^ {2}(?:async\s+)?(\w+)\s*[\(:{,]/gm
  let m
  while ((m = re.exec(tsContent)) !== null) {
    methods.add(m[1])
  }

  return methods
}

// ————— 主检查逻辑 —————

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
