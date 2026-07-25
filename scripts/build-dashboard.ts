import tailwind from 'bun-plugin-tailwind'

const result = await Bun.build({
  entrypoints: ['./src/dashboard-ui/index.html'],
  outdir: './src/dashboard-ui/dist',
  plugins: [tailwind],
  target: 'browser',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('dashboard UI build failed')
}

console.log(`dashboard UI built:\n${result.outputs.map((o) => `  ${o.path}`).join('\n')}`)
