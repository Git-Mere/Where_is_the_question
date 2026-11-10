// 사이트 대화 데이터(JSON) → 질문 목록 변환. DOM/chrome API에 의존하지 않는 순수 함수라 Node 테스트 대상.
// 반환 형식: Array<{ id, text, attachments: string[], images: number, weight: number }>
//   - id: 화면의 data-turn-key와 같은 메시지 ID
//   - weight: 이 질문부터 다음 질문 직전까지(답변 포함) 차지하는 분량 추정치. 마커 위치 어림에 사용
(function(root) {
    // 턴마다 글자 수와 별개로 붙는 여백/버튼 영역을 글자 수 단위로 환산한 값
    const TURN_BASE_WEIGHT = 220;
    const IMAGE_WEIGHT = 500;

    function textLength(str) {
        return typeof str === 'string' ? str.length : 0;
    }

    // ---- ChatGPT: /backend-api/conversation/{id} ----

    function chatgptPath(json) {
        const mapping = (json && json.mapping) || {};
        const path = [];
        let nodeId = json && json.current_node;
        const guard = new Set();
        while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
            guard.add(nodeId);
            path.push(mapping[nodeId]);
            nodeId = mapping[nodeId].parent;
        }
        return path.reverse();
    }

    function chatgptMessageText(message) {
        const content = message && message.content;
        if (!content) return '';
        if (Array.isArray(content.parts)) {
            return content.parts.filter(p => typeof p === 'string').join('\n').trim();
        }
        if (typeof content.text === 'string') return content.text.trim();
        return '';
    }

    function chatgptImageParts(message) {
        const parts = message && message.content && message.content.parts;
        if (!Array.isArray(parts)) return 0;
        return parts.filter(p => p && typeof p === 'object' && p.content_type === 'image_asset_pointer').length;
    }

    function isHiddenChatgptMessage(message) {
        const meta = message.metadata || {};
        if (meta.is_visually_hidden_from_conversation) return true;
        const type = message.content && message.content.content_type;
        // 맞춤 지시/메모리 컨텍스트 등 화면에 안 보이는 사용자 메시지
        if (type === 'user_editable_context' || type === 'model_editable_context') return true;
        return false;
    }

    function parseChatGPTConversation(json) {
        const questions = [];
        let current = null;
        for (const node of chatgptPath(json)) {
            const message = node.message;
            if (!message || !message.author) continue;
            if (isHiddenChatgptMessage(message)) continue;
            const role = message.author.role;
            if (role === 'user') {
                const text = chatgptMessageText(message);
                const attachmentMeta = (message.metadata && message.metadata.attachments) || [];
                const imageParts = chatgptImageParts(message);
                // 이미지도 attachments 메타에 이름이 들어있는 경우가 많다. 이름 있는 이미지는 파일명으로,
                // 메타가 없는 이미지 파트만 '이미지'로 센다.
                const imageMetaCount = attachmentMeta.filter(a => /^image\//.test(a.mime_type || '')).length;
                const attachments = attachmentMeta.map(a => a && a.name).filter(Boolean);
                const images = Math.max(0, imageParts - imageMetaCount);
                if (!text && attachments.length === 0 && imageParts === 0) continue;
                current = {
                    id: message.id,
                    text,
                    attachments,
                    images,
                    weight: TURN_BASE_WEIGHT + text.length + imageParts * IMAGE_WEIGHT
                };
                questions.push(current);
            } else if (current && (role === 'assistant' || role === 'tool')) {
                current.weight += textLength(chatgptMessageText(message)) + chatgptImageParts(message) * IMAGE_WEIGHT;
            }
        }
        return questions;
    }

    // ---- Claude: /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages ----

    function claudePath(json) {
        const messages = (json && json.chat_messages) || [];
        const leaf = json && json.current_leaf_message_uuid;
        if (!leaf) return messages.slice();
        const byId = new Map(messages.map(m => [m.uuid, m]));
        const path = [];
        const guard = new Set();
        let id = leaf;
        while (id && byId.has(id) && !guard.has(id)) {
            guard.add(id);
            const m = byId.get(id);
            path.push(m);
            id = m.parent_message_uuid;
        }
        // leaf 정보가 어긋나 경로를 못 만들면 전체 순서를 그대로 쓴다
        return path.length > 0 ? path.reverse() : messages.slice();
    }

    function claudeMessageText(message) {
        if (Array.isArray(message.content)) {
            const texts = message.content
                .filter(c => c && c.type === 'text' && typeof c.text === 'string')
                .map(c => c.text);
            if (texts.length > 0) return texts.join('\n').trim();
        }
        return typeof message.text === 'string' ? message.text.trim() : '';
    }

    function claudeAttachments(message) {
        const names = [];
        const push = (n) => { if (n && !names.includes(n)) names.push(n); };
        (message.files_v2 || message.files || []).forEach(f => push(f && (f.file_name || f.name)));
        (message.attachments || []).forEach(a => push(a && (a.file_name || a.name)));
        return names;
    }

    function parseClaudeConversation(json) {
        const questions = [];
        let current = null;
        for (const message of claudePath(json)) {
            if (!message) continue;
            if (message.sender === 'human') {
                const text = claudeMessageText(message);
                const attachments = claudeAttachments(message);
                if (!text && attachments.length === 0) continue;
                current = {
                    id: message.uuid,
                    text,
                    attachments,
                    images: 0,
                    weight: TURN_BASE_WEIGHT + text.length + attachments.length * IMAGE_WEIGHT
                };
                questions.push(current);
            } else if (current && message.sender === 'assistant') {
                current.weight += claudeMessageText(message).length;
            }
        }
        return questions;
    }

    const parsers = { parseChatGPTConversation, parseClaudeConversation };

    root.WITQ = root.WITQ || {};
    root.WITQ.parsers = parsers;
    if (typeof module !== 'undefined' && module.exports) module.exports = parsers;
})(typeof window !== 'undefined' ? window : globalThis);
