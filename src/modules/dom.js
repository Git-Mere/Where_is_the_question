window.WITQ = window.WITQ || {};

window.WITQ.dom = {
    scrollContainer: null,
    lastContainerCheck: 0,

    getScrollContainer: function() {
        const now = Date.now();
        // Use cached container if checked recently (within 2s) and still in DOM
        if (this.scrollContainer && document.body.contains(this.scrollContainer) && (now - this.lastContainerCheck < 2000)) {
            return this.scrollContainer;
        }
        
        this.lastContainerCheck = now;
        const site = window.WITQ.config.site;
        const config = window.WITQ.config.config;

        if (site === 'gemini') {
            const mainEl = document.querySelector('main');
            if (mainEl && mainEl.scrollHeight > mainEl.clientHeight) {
                this.scrollContainer = mainEl;
                return mainEl;
            }
        }

        const firstQuestion = document.querySelector(config.questionSelector);
        if (!firstQuestion) return window;

        let el = firstQuestion.parentElement;
        while (el && el !== document.body) {
            const overflow = window.getComputedStyle(el).overflowY;
            if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
                this.scrollContainer = el;
                return el;
            }
            el = el.parentElement;
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
