/**
 * TypeScript 编译测试
 * 确保 tsc --noEmit 零错误
 */
import { execSync } from 'child_process'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

describe('TypeScript 编译', () => {
  test('tsc --noEmit 零错误', () => {
    try {
      execSync('npx tsc --noEmit', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e: any) {
      const output = (e.stdout || '') + (e.stderr || '')
      throw new Error(`TypeScript 编译错误:\n${output}`)
    }
  })
})
