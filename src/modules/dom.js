window.WITQ = window.WITQ || {};

window.WITQ.dom = {
    scrollContainer: null,

    getScrollContainer: function() {
        if (this.scrollContainer && document.body.contains(this.scrollContainer)) {
             const style = window.getComputedStyle(this.scrollContainer);
             if ((style.overflowY === 'auto' || style.overflowY === 'scroll')) {
                return this.scrollContainer;
             }
        }
        
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
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
                this.scrollContainer = el;
                return el;
            }
            el = el.parentElement;
        }
        this.scrollContainer = window;
        return window;
    },

    getQuestionPositionInContainer: function(question, container) {
        if (container === window) {
            const rect = question.getBoundingClientRect();
            return rect.top + window.scrollY;
        }
        const visibleElement = question.closest('.user-query') || question;
        let offset = 0;
        let el = visibleElement;
        while (el && el !== container) {
            offset += el.offsetTop;
            el = el.offsetParent;
        }
        return offset;
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
