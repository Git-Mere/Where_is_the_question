(function(root) {
    const text = {
        escapeHtml: function(text) {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        normalizeFileName: function(name) {
            if (!name) return '';
            const cleaned = String(name)
                .replace(/^\s*\[[^\]]*icon[^\]]*\]\s*/i, '')
                .replace(/^\s*\([^\)]*icon[^\)]*\)\s*/i, '')
                .replace(/^\s*[a-z0-9]+\s*icon\s*/i, '')
                .trim();
            if (!cleaned) return '';
            if (/\.[a-z0-9]{2,8}$/i.test(cleaned)) return cleaned;
            const maybeExt = cleaned.match(/([a-z0-9]{2,8})$/i);
            if (maybeExt && cleaned.length > maybeExt[1].length) {
                return cleaned.replace(/([a-z0-9]{2,8})$/i, '.$1');
            }
            return cleaned;
        },

        stripYouSaid: function(str) {
            return str.replace(/\byou\s*said\b\s*:?\s*/ig, ' ');
        },

        normalizePlainText: function(str) {
            return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        },

        hashString: function(str) {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) + hash) + str.charCodeAt(i);
                hash |= 0;
            }
            return (hash >>> 0).toString(36);
        }
    };

    root.WITQ = root.WITQ || {};
    root.WITQ.text = text;
    if (typeof module !== 'undefined' && module.exports) module.exports = text;
})(typeof window !== 'undefined' ? window : globalThis);
