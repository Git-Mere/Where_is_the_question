'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const parsers = require('../src/modules/parsers.js');

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------
function chatgptConv(nodes, current) {
    const mapping = {};
    for (const n of nodes) mapping[n.id] = { id: n.id, parent: n.parent || null, children: [], message: n.message || null };
    return { mapping, current_node: current };
}
const user = (id, parts, metadata) => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts }, metadata: metadata || {} });
const assistant = (id, text) => ({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, metadata: {} });

test('chatgpt: follows current_node path and ignores other branches', () => {
    const json = chatgptConv([
        { id: 'root' },
        { id: 'u1', parent: 'root', message: user('u1', ['first']) },
        { id: 'a1', parent: 'u1', message: assistant('a1', 'answer one') },
        { id: 'u2old', parent: 'a1', message: user('u2old', ['old edit']) },
        { id: 'u2', parent: 'a1', message: user('u2', ['second']) },
        { id: 'a2', parent: 'u2', message: assistant('a2', 'answer two') }
    ], 'a2');
    const list = parsers.parseChatGPTConversation(json);
    assert.deepEqual(list.map(q => q.id), ['u1', 'u2']);
    assert.deepEqual(list.map(q => q.text), ['first', 'second']);
});

test('chatgpt: skips hidden and context messages', () => {
    const json = chatgptConv([
        { id: 'root' },
        { id: 'ctx', parent: 'root', message: { id: 'ctx', author: { role: 'user' }, content: { content_type: 'user_editable_context', parts: [] }, metadata: {} } },
        { id: 'hid', parent: 'ctx', message: user('hid', ['secret'], { is_visually_hidden_from_conversation: true }) },
        { id: 'u1', parent: 'hid', message: user('u1', ['visible']) }
    ], 'u1');
    assert.deepEqual(parsers.parseChatGPTConversation(json).map(q => q.id), ['u1']);
});

test('chatgpt: attachments from metadata, nameless images counted', () => {
    const msg = {
        id: 'u1',
        author: { role: 'user' },
        content: {
            content_type: 'multimodal_text',
            parts: [{ content_type: 'image_asset_pointer' }, { content_type: 'image_asset_pointer' }, 'look at this']
        },
        metadata: { attachments: [{ name: 'Design.txt', mime_type: 'text/plain' }, { name: 'shot.png', mime_type: 'image/png' }] }
    };
    const [q] = parsers.parseChatGPTConversation(chatgptConv([{ id: 'root' }, { id: 'u1', parent: 'root', message: msg }], 'u1'));
    assert.equal(q.text, 'look at this');
    assert.deepEqual(q.attachments, ['Design.txt', 'shot.png']);
    assert.equal(q.images, 1); // 이미지 2장 중 1장은 이름(shot.png)이 있음
});

test('chatgpt: assistant text adds to the preceding question weight', () => {
    const json = chatgptConv([
        { id: 'root' },
        { id: 'u1', parent: 'root', message: user('u1', ['q']) },
        { id: 'a1', parent: 'u1', message: assistant('a1', 'x'.repeat(1000)) },
        { id: 'u2', parent: 'a1', message: user('u2', ['q']) }
    ], 'u2');
    const [q1, q2] = parsers.parseChatGPTConversation(json);
    assert.ok(q1.weight > q2.weight + 900);
});

test('chatgpt: empty or malformed input returns empty list', () => {
    assert.deepEqual(parsers.parseChatGPTConversation({}), []);
    assert.deepEqual(parsers.parseChatGPTConversation(null), []);
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
test('claude: follows leaf path and reads text + files', () => {
    const json = {
        current_leaf_message_uuid: 'a2',
        chat_messages: [
            { uuid: 'h1', sender: 'human', parent_message_uuid: '000', content: [{ type: 'text', text: 'hello' }] },
            { uuid: 'a1', sender: 'assistant', parent_message_uuid: 'h1', content: [{ type: 'text', text: 'hi there' }] },
            { uuid: 'h2x', sender: 'human', parent_message_uuid: 'a1', content: [{ type: 'text', text: 'abandoned branch' }] },
            { uuid: 'h2', sender: 'human', parent_message_uuid: 'a1', content: [], files_v2: [{ file_name: 'photo.jpg' }] },
            { uuid: 'a2', sender: 'assistant', parent_message_uuid: 'h2', content: [{ type: 'text', text: 'nice photo' }] }
        ]
    };
    const list = parsers.parseClaudeConversation(json);
    assert.deepEqual(list.map(q => q.id), ['h1', 'h2']);
    assert.equal(list[0].text, 'hello');
    assert.deepEqual(list[1].attachments, ['photo.jpg']);
});

test('claude: without leaf uses given order', () => {
    const json = { chat_messages: [
        { uuid: 'h1', sender: 'human', text: 'one' },
        { uuid: 'h2', sender: 'human', text: 'two' }
    ] };
    assert.deepEqual(parsers.parseClaudeConversation(json).map(q => q.text), ['one', 'two']);
});
