'use strict';

// Fake reasoning is opt-in (Kiro filters reasoning extraction), so the tag
// injection test has to turn it on before config.js is first required.
process.env.FAKE_REASONING = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildKiroPayloadOpenAI,
  convertOpenAIMessagesToUnified,
  reasoningEffortToBudget,
} = require('../src/converters/openai');
const {
  anthropicToKiro,
  convertAnthropicMessages,
  extractSystemPrompt,
} = require('../src/converters/anthropic');
const {
  extractTextContent,
  extractImagesFromContent,
  sanitizeJsonSchema,
  validateToolNames,
  stripAllToolContent,
  ensureAlternatingRoles,
  ensureFirstMessageIsUser,
  mergeAdjacentMessages,
  buildKiroPayload,
  makeUnifiedMessage,
  makeUnifiedTool,
  makeThinkingConfig,
} = require('../src/converters/core');

// ==================================================================================================
// extractTextContent
// ==================================================================================================

test('extractTextContent: handles all formats', () => {
  assert.equal(extractTextContent('Hello'), 'Hello');
  assert.equal(extractTextContent(null), '');
  assert.equal(extractTextContent(undefined), '');
  assert.equal(extractTextContent([{ type: 'text', text: 'World' }]), 'World');
  assert.equal(extractTextContent([{ type: 'image', source: {} }]), '');
  assert.equal(extractTextContent(123), '123');
});

// ==================================================================================================
// extractImagesFromContent
// ==================================================================================================

test('extractImagesFromContent: OpenAI image_url format', () => {
  const images = extractImagesFromContent([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
  ]);
  assert.deepEqual(images, [{ mediaType: 'image/png', data: 'AAA=' }]);
});

test('extractImagesFromContent: Anthropic image format', () => {
  const images = extractImagesFromContent([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB=' } },
  ]);
  assert.deepEqual(images, [{ mediaType: 'image/jpeg', data: 'BBB=' }]);
});

test('extractImagesFromContent: http URLs are skipped', () => {
  const images = extractImagesFromContent([
    { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
  ]);
  assert.deepEqual(images, []);
});

// ==================================================================================================
// sanitizeJsonSchema
// ==================================================================================================

test('sanitizeJsonSchema: removes empty required arrays and additionalProperties', () => {
  const schema = {
    type: 'object',
    required: [],
    additionalProperties: true,
    properties: {
      a: { type: 'string' },
      b: { required: [], additionalProperties: false, type: 'object' },
    },
  };

  const result = sanitizeJsonSchema(schema);
  assert.equal('required' in result, false);
  assert.equal('additionalProperties' in result, false);
  assert.equal('required' in result.properties.b, false);
  assert.equal('additionalProperties' in result.properties.b, false);
});

test('sanitizeJsonSchema: preserves non-empty required', () => {
  const result = sanitizeJsonSchema({ type: 'object', required: ['a'] });
  assert.deepEqual(result.required, ['a']);
});

// ==================================================================================================
// validateToolNames
// ==================================================================================================

test('validateToolNames: throws on names longer than 64 chars', () => {
  const tools = [
    makeUnifiedTool('ok_name'),
    makeUnifiedTool('a'.repeat(70)),
  ];
  assert.throws(() => validateToolNames(tools), /64 characters/);
});

test('validateToolNames: passes for short names', () => {
  const tools = [makeUnifiedTool('short_name')];
  assert.doesNotThrow(() => validateToolNames(tools));
});

// ==================================================================================================
// convertOpenAIMessagesToUnified
// ==================================================================================================

test('convertOpenAIMessagesToUnified: extracts system prompt and tool messages', () => {
  const messages = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    { role: 'user', content: 'Thanks' },
  ];

  const [systemPrompt, unified] = convertOpenAIMessagesToUnified(messages);
  assert.equal(systemPrompt, 'You are helpful');
  assert.equal(unified.length, 4);
  assert.equal(unified[0].role, 'user');
  assert.equal(unified[1].role, 'assistant');
  assert.equal(unified[1].toolCalls.length, 1);
  // Tool message becomes a user message with tool_results
  assert.equal(unified[2].role, 'user');
  assert.equal(unified[2].toolResults.length, 1);
  assert.equal(unified[2].toolResults[0].tool_use_id, 'call_1');
});

// ==================================================================================================
// buildKiroPayloadOpenAI
// ==================================================================================================

test('buildKiroPayloadOpenAI: builds complete payload', () => {
  const request = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello there' },
    ],
  };

  const payload = buildKiroPayloadOpenAI(request, 'conv-123', 'arn:aws:codewhisperer:us-east-1:123:profile/id');

  assert.equal(payload.profileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/id');
  assert.equal(payload.conversationState.conversationId, 'conv-123');
  assert.equal(payload.conversationState.chatTriggerType, 'MANUAL');
  assert.equal(payload.conversationState.currentMessage.userInputMessage.modelId, 'claude-sonnet-4.5');
  assert.equal(payload.conversationState.currentMessage.userInputMessage.origin, 'AI_EDITOR');
  assert.ok(payload.conversationState.currentMessage.userInputMessage.content.includes('Be concise'));
  assert.ok(payload.conversationState.currentMessage.userInputMessage.content.includes('Hello there'));
});

test('buildKiroPayloadOpenAI: includes tools in userInputMessageContext', () => {
  const request = {
    model: 'auto',
    messages: [{ role: 'user', content: 'What is 2+2?' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
  };

  const payload = buildKiroPayloadOpenAI(request, 'conv-1', '');
  const context = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.equal(context.tools.length, 1);
  assert.equal(context.tools[0].toolSpecification.name, 'get_weather');
});

test('buildKiroPayloadOpenAI: converts tool calls and results in history', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    messages: [
      { role: 'user', content: 'Check the weather' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      { role: 'user', content: 'Thanks!' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
  };

  const payload = buildKiroPayloadOpenAI(request, 'conv-2', '');

  // history: user, assistant(with toolUses) = 2 entries;
  // the final merged user message (tool result + "Thanks!") is the current message
  assert.equal(payload.conversationState.history.length, 2);
  const assistantEntry = payload.conversationState.history[1];
  assert.equal(assistantEntry.assistantResponseMessage.toolUses.length, 1);
  assert.equal(assistantEntry.assistantResponseMessage.toolUses[0].name, 'get_weather');

  const currentMessage = payload.conversationState.currentMessage.userInputMessage;
  assert.equal(currentMessage.userInputMessageContext.toolResults.length, 1);
  assert.equal(currentMessage.userInputMessageContext.toolResults[0].toolUseId, 'call_1');
});

test('buildKiroPayloadOpenAI: throws when no messages', () => {
  assert.throws(
    () => buildKiroPayloadOpenAI({ model: 'auto', messages: [] }, 'conv', ''),
    /No messages to send/
  );
});

test('buildKiroPayloadOpenAI: injects thinking tags for last user message', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const payload = buildKiroPayloadOpenAI(request, 'conv', '');
  const content = payload.conversationState.currentMessage.userInputMessage.content;
  assert.ok(content.startsWith('<thinking_mode>enabled</thinking_mode>'));
});

// ==================================================================================================
// anthropicToKiro
// ==================================================================================================

test('anthropicToKiro: system prompt as string', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    max_tokens: 1000,
    system: 'You are Claude',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const payload = anthropicToKiro(request, 'conv-a', '');
  const content = payload.conversationState.currentMessage.userInputMessage.content;
  assert.ok(content.includes('You are Claude'));
  assert.ok(content.includes('Hello'));
});

test('anthropicToKiro: system prompt as block list with cache_control', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'System text', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Hi' }],
  };

  const payload = anthropicToKiro(request, 'conv-b', '');
  assert.ok(
    payload.conversationState.currentMessage.userInputMessage.content.includes('System text')
  );
});

test('anthropicToKiro: content block format with tool_result and tool_use', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    max_tokens: 1000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Run the tool' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Result:' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Done' },
        ],
      },
      { role: 'user', content: 'Nice' },
    ],
    tools: [
      {
        name: 'bash',
        description: 'Run a command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  };

  const payload = anthropicToKiro(request, 'conv-c', '');

  // history: user, assistant(with toolUses) = 2 entries;
  // the final merged user message (tool_result + "Nice") is the current message
  const history = payload.conversationState.history;
  assert.equal(history.length, 2);
  assert.equal(history[1].assistantResponseMessage.toolUses[0].name, 'bash');

  const currentMessage = payload.conversationState.currentMessage.userInputMessage;
  assert.equal(currentMessage.userInputMessageContext.toolResults[0].toolUseId, 'toolu_1');
});

test('anthropicToKiro: thinking disabled config', () => {
  const request = {
    model: 'claude-sonnet-4.5',
    max_tokens: 1000,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const payload = anthropicToKiro(request, 'conv-d', '');
  const content = payload.conversationState.currentMessage.userInputMessage.content;
  assert.ok(!content.startsWith('<thinking_mode>'));
});

test('convertAnthropicMessages: handles plain strings', () => {
  const messages = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
  ];
  const unified = convertAnthropicMessages(messages);
  assert.equal(unified[0].role, 'user');
  assert.equal(unified[0].content, 'Hi');
  assert.equal(unified[1].content, 'Hello');
});

test('extractSystemPrompt: all formats', () => {
  assert.equal(extractSystemPrompt(null), '');
  assert.equal(extractSystemPrompt('plain'), 'plain');
  assert.equal(
    extractSystemPrompt([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb'
  );
});

// ==================================================================================================
// Message merging helpers
// ==================================================================================================

test('stripAllToolContent: converts tool content to text when no tools', () => {
  const messages = [
    makeUnifiedMessage('user', 'question', null, [{ tool_use_id: 'call_1', content: 'result' }]),
  ];

  const [stripped, hadToolContent] = stripAllToolContent(messages);
  assert.equal(hadToolContent, true);
  assert.ok(stripped[0].content.includes('[Tool Result (call_1)]'));
  assert.equal(stripped[0].toolResults, null);
});

test('mergeAdjacentMessages: merges same-role messages', () => {
  const messages = [
    makeUnifiedMessage('user', 'a'),
    makeUnifiedMessage('user', 'b'),
    makeUnifiedMessage('assistant', 'c'),
  ];

  const merged = mergeAdjacentMessages(messages);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, 'a\nb');
});

test('ensureFirstMessageIsUser: prepends synthetic message', () => {
  const messages = [makeUnifiedMessage('assistant', 'hello')];
  const result = ensureFirstMessageIsUser(messages);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, '(empty placeholder)');
});

test('ensureAlternatingRoles: inserts synthetic assistants between users', () => {
  const messages = [
    makeUnifiedMessage('user', 'a'),
    makeUnifiedMessage('user', 'b'),
    makeUnifiedMessage('user', 'c'),
  ];

  const result = ensureAlternatingRoles(messages);
  assert.equal(result.length, 5);
  assert.equal(result[1].role, 'assistant');
  assert.equal(result[1].content, '(empty placeholder)');
});

// ==================================================================================================
// reasoningEffortToBudget
// ==================================================================================================

test('reasoningEffortToBudget: percentage mapping', () => {
  assert.equal(reasoningEffortToBudget(4096, 'high'), 3276);
  assert.equal(reasoningEffortToBudget(10000, 'medium'), 5000);
  assert.equal(reasoningEffortToBudget(10000, 'low'), 2000);
});