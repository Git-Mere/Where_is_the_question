window.WITQ = window.WITQ || {};

window.WITQ.dom = {
    scrollContainer: null,
    lastContainerCheck: 0,
    
    isScrollableElement: function(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScrollByStyle = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        const canScrollBySize = el.scrollHeight > el.clientHeight + 1;
        return canScrollByStyle && canScrollBySize;
    },

    findScrollableAncestor: function(startEl) {
        let el = startEl;
        while (el && el !== document.body) {
            if (this.isScrollableElement(el)) return el;
            el = el.parentElement;
        }
        return null;
    },

    getScrollContainer: function() {
        const now = Date.now();
        if (
            this.scrollContainer &&
            (this.scrollContainer === window || document.body.contains(this.scrollContainer)) &&
            (this.scrollContainer === window || this.isScrollableElement(this.scrollContainer)) &&
            (now - this.lastContainerCheck < 500)
        ) {
            return this.scrollContainer;
        }
        
        this.lastContainerCheck = now;
        const site = window.WITQ.config.site;
        const config = window.WITQ.config.config;
        const firstQuestion = document.querySelector(config.questionSelector);
        
        // Explicitly handle known site containers for better reliability
        if (site === 'gemini') {
            if (firstQuestion) {
                const ancestor = this.findScrollableAncestor(firstQuestion);
                if (ancestor) {
                    this.scrollContainer = ancestor;
                    return ancestor;
                }
            }
            const mainEl = document.querySelector('main');
            if (this.isScrollableElement(mainEl)) {
                this.scrollContainer = mainEl;
                return mainEl;
            }
        }

        if (site === 'chatgpt') {
            // ChatGPT UI variants: class names and wrappers may differ across deployments.
            const chatContainer = document.querySelector('div[role="presentation"] .flex-col.flex-1.overflow-y-auto') || 
                                  document.querySelector('div[role="presentation"] .overflow-y-auto') ||
                                  document.querySelector('main div.overflow-y-auto');
            if (chatContainer) {
                this.scrollContainer = chatContainer;
                return chatContainer;
            }
        }

        if (!firstQuestion) {
            this.scrollContainer = window;
            return window;
        }

        // Fallback: Search upwards for the closest scrollable container
        const fallbackAncestor = this.findScrollableAncestor(firstQuestion.parentElement);
        if (fallbackAncestor) {
            this.scrollContainer = fallbackAncestor;
            return fallbackAncestor;
        }
        
        this.scrollContainer = window;
        return window;
    },

    getQuestionPositionInContainer: function(question, container) {
        const visibleElement = question.closest('.user-query') || question.closest('div[data-testid^="conversation-turn"]') || question;
        const rect = visibleElement.getBoundingClientRect();

        if (container === window) {
            return rect.top + window.scrollY;
        }
        
        const containerRect = container.getBoundingClientRect();
        return rect.top - containerRect.top + container.scrollTop;
    },
    
    getScrollOffset: function(scrollContainer) {
        const site = window.WITQ.config.site;
        if (site === 'gemini') return 20;
        if (scrollContainer === window) {
            const header = document.querySelector('header') || document.querySelector('nav') || document.querySelector('[data-testid="sidebar-nav"]');
            return (header ? header.getBoundingClientRect().height : 0) + 12;
        }
        // ChatGPT specific offset for internal scroll
        if (site === 'chatgpt') return 15;
        return 12;
    },

    scrollToQuestionPosition: function(rawPosition, scrollContainerOverride = null) {
        const container = scrollContainerOverride || this.getScrollContainer();
        const offset = this.getScrollOffset(container);
        const target = Math.max(rawPosition - offset, 0);

        if (typeof container.scrollTo === 'function') {
            container.scrollTo({ top: target, behavior: 'smooth' });
        } else {
            container.scrollTop = target;
        }
    }
};
