/**
 * Proves a model refusal reaches the user instead of ending the turn empty.
 *
 * A refusal arrives as response.refusal.delta on the Responses wire and as
 * delta.refusal on the Chat wire. Both used to fall through the reader, so a
 * refusal-only turn closed with zero blocks and finish 'stop' — exactly the
 * input src/adapter.js turns into EMPTY_RESPONSE, which is a retryable code:
 * one real answer was billed up to three times and never shown. These cases pin
 * the refusal text onto the same text-block path the visible answer uses.
 *
 * Pure memory: no server, no port, no stub upstream.
 *
 * Run: node scripts/responses-refusal-test.mjs
 */
import { readStream } from '../src/stream.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name
    + (ok ? '' : ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)))
}

/** Read a whole frame list, keeping the generator's final state. */
const drain = async (frames, wire) => {
  const chunks = []
  const iterator = readStream(frames, wire, new Map())
  for (;;) {
    const step = await iterator.next()
    if (step.done) return { chunks, state: step.value }
    chunks.push(step.value)
  }
}

const starts = chunks => chunks.filter(chunk => chunk.type === 'block-start')
  .map(chunk => String(chunk.index) + ':' + chunk.blockType)
const ends = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.index)
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const closedText = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
  .map(chunk => chunk.block.text)

const REFUSAL = 'I cannot help with that.'

const responsesRefusal = () => [
  JSON.stringify({ type: 'response.content_part.added', output_index: 0, part: { type: 'refusal', refusal: '' } }),
  JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
  JSON.stringify({ type: 'response.refusal.done', output_index: 0, refusal: REFUSAL }),
  JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } } }),
]

const chatRefusal = () => [
  JSON.stringify({ choices: [{ index: 0, delta: { refusal: REFUSAL } }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]',
]

// REF-1: a Responses turn that is nothing but a refusal is still a turn.
{
  const { chunks, state } = await drain(responsesRefusal(), 'responses')
  check('REF-1 responses refusal opens one text block', starts(chunks), ['0:text'])
  check('REF-1 the refusal is the visible text', textOf(chunks), REFUSAL)
  check('REF-1 the block closes once carrying the refusal', closedText(chunks), [REFUSAL])
  check('REF-1 the turn no longer reads as empty', state.sawText, true)
  check('REF-1 the finish reason is untouched', state.finish, 'stop')
}

// REF-2: the same refusal on the Chat wire, under delta.refusal.
{
  const { chunks, state } = await drain(chatRefusal(), 'chat')
  check('REF-2 chat refusal opens one text block', starts(chunks), ['0:text'])
  check('REF-2 the refusal is the visible text', textOf(chunks), REFUSAL)
  check('REF-2 the block closes once carrying the refusal', closedText(chunks), [REFUSAL])
  check('REF-2 the turn no longer reads as empty', state.sawText, true)
  check('REF-2 the finish reason is untouched', state.finish, 'stop')
}

// REF-3: delta plus the echo frame must not print the refusal twice.
{
  const frames = [
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
    JSON.stringify({ type: 'response.refusal.done', output_index: 0, refusal: REFUSAL }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks } = await drain(frames, 'responses')
  check('REF-3 the echo frame does not double the refusal', textOf(chunks), REFUSAL)
  check('REF-3 there is still exactly one text block', starts(chunks), ['0:text'])
  check('REF-3 and it closes exactly once', ends(chunks), [0])
}

// REF-4: the ordinary answer paths keep behaving exactly as before.
{
  const frames = [
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: ' world' }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-4 output_text still builds one text block', starts(chunks), ['0:text'])
  check('REF-4 output_text still concatenates', textOf(chunks), 'Hello world')
  check('REF-4 output_text still closes once', ends(chunks), [0])
  check('REF-4 output_text still reports text and stop', [state.sawText, state.finish], [true, 'stop'])
}
{
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: ' world' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ]
  const { chunks, state } = await drain(frames, 'chat')
  check('REF-4 chat content still builds one text block', starts(chunks), ['0:text'])
  check('REF-4 chat content still concatenates', textOf(chunks), 'Hello world')
  check('REF-4 chat content still closes once', ends(chunks), [0])
  check('REF-4 chat content still reports text and stop', [state.sawText, state.finish], [true, 'stop'])
}

// REF-5: reasoning that ends in a refusal keeps block indices contiguous and
// closes every block exactly once.
{
  const frames = [
    JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'weighing it' }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 1, delta: REFUSAL }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-5 reasoning then refusal keeps contiguous indices', starts(chunks), ['0:reasoning', '1:text'])
  check('REF-5 each block ends exactly once', ends(chunks), [0, 1])
  check('REF-5 the refusal owns the second block', closedText(chunks), [REFUSAL])
  check('REF-5 both kinds are reported', [state.sawReasoning, state.sawText], [true, true])
}

// REF-6: a refusal followed by a tool call keeps the two blocks apart.
{
  const frames = [
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.txt"}' }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-6 the refusal and the call are separate blocks', starts(chunks), ['0:text', '1:tool-call'])
  check('REF-6 neither block swallows the other', ends(chunks), [0, 1])
  check('REF-6 the refusal text stays in its own block', closedText(chunks), [REFUSAL])
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  check('REF-6 the call still closes with its arguments', [call?.block?.name, call?.block?.arguments], ['read_file', '{"path":"a.txt"}'])
  check('REF-6 both a refusal and a tool call are reported', [state.sawText, state.sawToolCall], [true, true])
}

// REF-7: a gateway that sends an empty or null refusal must not open a block.
{
  const frames = [
    JSON.stringify({ type: 'response.content_part.added', output_index: 0, part: { type: 'refusal', refusal: '' } }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: '' }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: null }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-7 an empty responses refusal emits nothing', chunks, [])
  check('REF-7 and does not claim text arrived', state.sawText, false)
}
{
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { refusal: '' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { refusal: null } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]
  const { chunks, state } = await drain(frames, 'chat')
  check('REF-7 an empty chat refusal emits nothing', chunks, [])
  check('REF-7 and does not claim text arrived', state.sawText, false)
}

console.log(failures === 0
  ? '\nresponses-refusal: a refusal is an answer'
  : '\n' + failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
