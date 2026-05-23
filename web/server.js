#!/usr/bin/env node
// GeminiClaw Web UI Server — port 18890
// 独立于 18888 API 服务，零影响

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = 18890
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML_FILE = path.join(__dirname, 'index.html')

const server = http.createServer((req, res) => {
  // 只服务根路径
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
    return
  }

  fs.readFile(HTML_FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal Server Error')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GeminiClaw Web UI → http://127.0.0.1:${PORT}`)
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用`)
  } else {
    console.error('Server error:', err)
  }
  process.exit(1)
})
