import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function truncate(text, max = 12000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`
}

export function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Run a process and capture its stdout as a Buffer (binary-safe on Windows).
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, env?: Record<string,string>, allowFail?: boolean}} [opts]
 */
export function run(file, args, opts = {}) {
  const timeout = opts.timeout ?? 30000
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const chunks = []
    const errors = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`命令超时: ${file} ${args.join(' ')}`))
    }, timeout)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size <= 48 * 1024 * 1024) chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (errors.length < 400) errors.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = {
        code,
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errors).toString('utf8'),
      }
      if (code !== 0 && !opts.allowFail) {
        const message = result.stderr.trim() || result.stdout.toString('utf8').trim() || `exit ${code}`
        const error = new Error(message)
        error.code = code
        error.stdout = result.stdout
        error.stderr = result.stderr
        reject(error)
        return
      }
      resolve(result)
    })
  })
}

export async function runText(file, args, opts = {}) {
  const result = await run(file, args, opts)
  return result.stdout.toString('utf8').replace(/\r\n/g, '\n')
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, file)
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function stripPrefix(text, prefix) {
  if (typeof text !== 'string') return text
  if (!text.startsWith(prefix)) return text
  return text.slice(prefix.length).trim()
}
