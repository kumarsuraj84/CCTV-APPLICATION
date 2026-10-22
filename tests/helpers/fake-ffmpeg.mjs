// A stand-in for ffmpeg in tests, run with `node fake-ffmpeg.mjs <mode>`. It is a real child process with real pipes, so the pipe, the
// back-pressure and the killing are the real ones; it just does not understand video.
//   copy      standard input to standard output, then ends (what ffmpeg does with `-c copy` of a stream)
//   fail      writes an error that names an address, ends with code 1 without any output
//   fail-late copies the first chunk, then ends with code 1
//   hang      reads nothing, writes nothing, never ends
//   linger    copies, but does not end when its input ends
const mode = process.argv[2] ?? 'copy'

if (mode === 'copy') {
  process.stdin.pipe(process.stdout)
} else if (mode === 'linger') {
  process.stdin.on('data', (c) => process.stdout.write(c))
  setInterval(() => {}, 1000)
} else if (mode === 'fail') {
  process.stderr.write('[in#0] Error opening input rtsp://admin:hunter2@10.0.0.5/Streaming/tracks/101?x=1: Invalid data found when processing input\n')
  process.exit(1)
} else if (mode === 'fail-late') {
  process.stdin.once('data', (c) => {
    process.stdout.write(c, () => {
      process.stderr.write('Conversion failed!\n')
      process.exit(1)
    })
  })
} else if (mode === 'hang') {
  setInterval(() => {}, 1000)
}
process.stdin.on('error', () => {})
process.stdout.on('error', () => {})
