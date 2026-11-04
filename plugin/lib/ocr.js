import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OCR_EXE = join(here, '..', 'assets', 'ocr', 'DshOcr.exe')

export function compactLineText(value) {
  return String(value ?? '').replace(/\s+/gu, '')
}

export async function ocrImage(path) {
  return await new Promise((resolve, reject) => {
    execFile(OCR_EXE, [path], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`OCR 失败: ${stderr || error.message}`))
      try {
        const parsed = JSON.parse(String(stdout).trim())
        parsed.lines = (Array.isArray(parsed.lines) ? parsed.lines : [])
          .map((line) => ({
            ...line,
            text: String(line.text ?? '').trim(),
            compact: compactLineText(line.text),
          }))
          .filter((line) => line.text)
        return resolve(parsed)
      } catch (parseError) {
        return reject(new Error(`OCR 输出解析失败: ${parseError.message}`))
      }
    })
  })
}
