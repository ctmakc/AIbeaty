(() => {
  const CONFIG = {
    leadEmail: "hello@aibeaty.ai",
    webhookUrl: "",
    calendlyUrl: "",
    whatsappUrl: "",
    phone: "",
    instagramUrl: "",
    ...window.AIBEATY_CONFIG,
  };

  const LEGAL_DOCUMENTS = {
    privacy: {
      title: "Политика конфиденциальности",
      updatedAt: "17 апреля 2026",
      body: `
        <p>AIbeaty обрабатывает персональные данные только в объеме, который нужен для ответа на заявку, демонстрации продукта, подготовки коммерческого предложения и ведения коммуникации по внедрению.</p>
        <h3>Какие данные мы можем получить</h3>
        <p>Имя, название бизнеса, город, телефон, email, комментарий к заявке, а также технические данные о странице обращения и времени отправки формы.</p>
        <h3>Для чего используются данные</h3>
        <ul>
          <li>связаться по заявке и согласовать следующий шаг;</li>
          <li>подготовить demo flow, аудит или предложение по внедрению;</li>
          <li>вести историю обращений и не терять договоренности;</li>
          <li>улучшать качество сайта и воронки захвата заявок.</li>
        </ul>
        <h3>Передача третьим лицам</h3>
        <p>Данные не продаются и не передаются посторонним лицам. Передача возможна только подрядчикам и сервисам, которые участвуют в обработке заявки, доставке сообщений, CRM-учете или технической поддержке AIbeaty.</p>
        <h3>Срок хранения</h3>
        <p>Данные хранятся столько, сколько это разумно необходимо для работы с обращением, договорных отношений и исполнения юридических обязанностей.</p>
        <h3>Права пользователя</h3>
        <p>Вы можете запросить уточнение, обновление или удаление своих данных, написав на <a href="mailto:${CONFIG.leadEmail}">${CONFIG.leadEmail}</a>.</p>
      `,
    },
    terms: {
      title: "Условия использования",
      updatedAt: "17 апреля 2026",
      body: `
        <p>Сайт AIbeaty предоставляет информацию о продукте, сценариях внедрения, тарифах и способах связи с командой проекта.</p>
        <h3>Назначение сайта</h3>
        <p>Материалы сайта предназначены для ознакомления с платформой и отправки заявки на аудит, демо или коммерческое обсуждение.</p>
        <h3>Коммерческие условия</h3>
        <p>Тарифы, сроки запуска, интеграции и состав работ на сайте носят информационный характер и могут уточняться в индивидуальном предложении, договоре или приложениях к нему.</p>
        <h3>Ограничение гарантий</h3>
        <p>AIbeaty не гарантирует конкретные финансовые результаты от использования сайта или материалов сайта без внедрения, настройки процессов и подключения источников данных клиента.</p>
        <h3>Интеллектуальная собственность</h3>
        <p>Тексты, структура, визуальные элементы и программные компоненты сайта принадлежат AIbeaty или используются на законных основаниях. Копирование материалов без согласования не допускается.</p>
        <h3>Связь по условиям</h3>
        <p>По вопросам использования сайта и коммерческих условий можно написать на <a href="mailto:${CONFIG.leadEmail}">${CONFIG.leadEmail}</a>.</p>
      `,
    },
    cookies: {
      title: "Cookie Notice",
      updatedAt: "17 апреля 2026",
      body: `
        <p>AIbeaty использует cookie и похожие технологии, чтобы сайт корректно работал, запоминал базовые действия пользователя и помогал оценивать качество входящих обращений.</p>
        <h3>Что именно используется</h3>
        <ul>
          <li>технические cookie для корректной работы интерфейса;</li>
          <li>локальное сохранение данных формы, если заявка не ушла во внешний endpoint;</li>
          <li>аналитические инструменты, если они подключены в конфигурации проекта.</li>
        </ul>
        <h3>Что не делаем</h3>
        <p>Мы не используем cookie для скрытой продажи данных или несанкционированного отслеживания вне задач работы сайта и воронки.</p>
        <h3>Как управлять cookie</h3>
        <p>Вы можете ограничить или удалить cookie в настройках браузера. Это может повлиять на корректность работы отдельных функций сайта.</p>
      `,
    },
  };

  const state = {
    activeIntent: "audit",
    activeSource: "landing",
    mobileMenuOpen: false,
    modalOpen: false,
    legalModalOpen: false,
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    markSections();
    injectLeadModal();
    injectLegalModal();
    injectContactStrip();
    refreshLandingContent();
    setupMobileMenu();
    wirePrimaryCtas();
    repairPlaceholderLinks();
    wireModalInteractions();
    wireLegalModalInteractions();
  }

  function markSections() {
    const sections = [...document.querySelectorAll("section")];
    sections.forEach((section) => {
      const text = section.textContent || "";
      if (!section.id && text.includes("Реальные результаты")) {
        section.id = "results";
      }
      if (!section.id && text.includes("Готовы трансформировать")) {
        section.id = "contact";
      }
    });
  }

  function injectLeadModal() {
    const modal = document.createElement("div");
    modal.className = "aibeaty-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="aibeaty-modal__backdrop" data-close-modal></div>
      <div class="aibeaty-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="lead-modal-title">
        <button class="aibeaty-modal__close" type="button" aria-label="Закрыть" data-close-modal>&times;</button>
        <div class="aibeaty-modal__content">
          <div class="aibeaty-modal__intro">
            <span class="aibeaty-chip">Founder-led rollout</span>
            <h2 id="lead-modal-title">Запросить AI-аудит для салона</h2>
            <p>Оставьте контакты, и мы соберем короткий план: где теряются лиды, как автоматизировать follow-up и что запускать первым.</p>
          </div>
          <form class="aibeaty-form" id="lead-form">
            <input type="hidden" name="intent" value="audit">
            <input type="hidden" name="source" value="landing">
            <label>
              <span>Имя</span>
              <input name="name" type="text" autocomplete="name" placeholder="Анна" required>
            </label>
            <label>
              <span>Салон / сеть</span>
              <input name="business" type="text" autocomplete="organization" placeholder="Beauty Studio One" required>
            </label>
            <label>
              <span>Город</span>
              <input name="city" type="text" autocomplete="address-level2" placeholder="Ваш город">
            </label>
            <label>
              <span>Телефон / Telegram / WhatsApp</span>
              <input name="phone" type="text" autocomplete="tel" placeholder="+1 202 555 0147" required>
            </label>
            <label>
              <span>Email</span>
              <input name="email" type="email" autocomplete="email" placeholder="owner@salon.ru" required>
            </label>
            <label>
              <span>Что нужно сейчас</span>
              <select name="goal">
                <option value="audit">AI-аудит и план запуска</option>
                <option value="demo">Показать демо платформы</option>
                <option value="sales">Настроить захват и follow-up лидов</option>
                <option value="rebooking">Поднять повторные записи</option>
                <option value="owner_visibility">Видимость для owner / управляющего</option>
              </select>
            </label>
            <label class="aibeaty-form__full">
              <span>Комментарий</span>
              <textarea name="notes" rows="4" placeholder="Например: 2 салона, входящие из Instagram и WhatsApp, нужно меньше потерянных заявок."></textarea>
            </label>
            <label class="aibeaty-consent aibeaty-form__full">
              <input name="consent" type="checkbox" required>
              <span>Согласен на обработку заявки и обратную связь по проекту. <button type="button" class="aibeaty-inline-link" data-open-legal-modal data-legal-doc="privacy">Политика</button>, <button type="button" class="aibeaty-inline-link" data-open-legal-modal data-legal-doc="terms">Условия</button>, <button type="button" class="aibeaty-inline-link" data-open-legal-modal data-legal-doc="cookies">Cookie</button>.</span>
            </label>
            <div class="aibeaty-form__actions aibeaty-form__full">
              <button class="aibeaty-button aibeaty-button--primary" type="submit">Отправить запрос</button>
              <button class="aibeaty-button aibeaty-button--secondary" type="button" data-book-demo>Открыть demo flow</button>
            </div>
            <p class="aibeaty-form__status" aria-live="polite"></p>
          </form>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function injectLegalModal() {
    if (document.querySelector(".aibeaty-legal-modal")) {
      return;
    }

    const modal = document.createElement("div");
    modal.className = "aibeaty-legal-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="aibeaty-modal__backdrop" data-close-legal-modal></div>
      <div class="aibeaty-modal__dialog aibeaty-modal__dialog--legal" role="dialog" aria-modal="true" aria-labelledby="legal-modal-title">
        <button class="aibeaty-modal__close" type="button" aria-label="Закрыть" data-close-legal-modal>&times;</button>
        <div class="aibeaty-modal__content aibeaty-legal">
          <div class="aibeaty-modal__intro">
            <span class="aibeaty-chip">Legal</span>
            <h2 id="legal-modal-title">Правовой документ</h2>
            <p class="aibeaty-legal__meta" id="legal-modal-updated"></p>
          </div>
          <div class="aibeaty-legal__body" id="legal-modal-body"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function injectContactStrip() {
    const footer = document.querySelector("footer");
    if (!footer || document.querySelector(".aibeaty-contact-strip")) {
      return;
    }

    const section = document.createElement("section");
    section.className = "aibeaty-contact-strip";
    section.id = "founder-call";
    section.innerHTML = `
      <div class="aibeaty-contact-strip__inner">
        <div>
          <p class="aibeaty-contact-strip__eyebrow">14 дней trial</p>
          <h2>Запустим AIbeaty как рабочий контур для лидов, follow-up и повторных записей</h2>
          <p>Подходит салонам, сетям и клиникам, где заявки приходят из нескольких каналов, а owner хочет видеть воронку и загрузку без ручной сводки.</p>
        </div>
        <div class="aibeaty-contact-strip__actions">
          <button class="aibeaty-button aibeaty-button--primary" type="button" data-open-lead-modal data-intent="audit" data-source="contact_strip">Запросить AI-аудит</button>
          <button class="aibeaty-button aibeaty-button--secondary" type="button" data-open-lead-modal data-intent="demo" data-source="contact_strip">Заказать демо</button>
        </div>
      </div>
    `;
    footer.parentNode.insertBefore(section, footer);
  }

  function refreshLandingContent() {
    rewriteHeroSection();
    rewriteResultsSection();
    rewriteCasesSection();
    rewritePricingSection();
    rewriteFinalCtaSection();
    rewriteFooterSection();
  }

  function setupMobileMenu() {
    const nav = document.querySelector("nav");
    const toggle = nav?.querySelector("button.md\\:hidden");
    const desktopMenu = nav?.querySelector(".hidden.md\\:flex");

    if (!nav || !toggle || !desktopMenu) {
      return;
    }

    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Открыть меню");

    const panel = document.createElement("div");
    panel.className = "aibeaty-mobile-menu";
    panel.setAttribute("hidden", "");

    const menuLinks = [...desktopMenu.querySelectorAll("a")]
      .map((anchor) => `<a href="${anchor.getAttribute("href")}">${anchor.textContent.trim()}</a>`)
      .join("");

    panel.innerHTML = `
      <div class="aibeaty-mobile-menu__card">
        ${menuLinks}
        <button class="aibeaty-button aibeaty-button--primary" type="button" data-open-lead-modal data-intent="audit" data-source="mobile_menu">Начать бесплатно</button>
      </div>
    `;

    nav.appendChild(panel);

    toggle.addEventListener("click", () => {
      state.mobileMenuOpen = !state.mobileMenuOpen;
      toggle.setAttribute("aria-expanded", String(state.mobileMenuOpen));
      if (state.mobileMenuOpen) {
        panel.removeAttribute("hidden");
        panel.classList.add("is-open");
        document.body.classList.add("aibeaty-lock-scroll");
      } else {
        panel.setAttribute("hidden", "");
        panel.classList.remove("is-open");
        document.body.classList.remove("aibeaty-lock-scroll");
      }
    });

    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.matches("a, button")) {
        state.mobileMenuOpen = false;
        toggle.setAttribute("aria-expanded", "false");
        panel.setAttribute("hidden", "");
        panel.classList.remove("is-open");
        document.body.classList.remove("aibeaty-lock-scroll");
      }
    });
  }

  function wirePrimaryCtas() {
    [...document.querySelectorAll("button, a")].forEach((element) => {
      const text = normalizedText(element.textContent);
      if (!text) {
        return;
      }

      if (text.includes("начать бесплатно") || text.includes("запросить ai-аудит") || text.includes("14-дневный trial")) {
        bindLeadTrigger(element, "audit");
      } else if (text.includes("заказать демо")) {
        bindLeadTrigger(element, "demo");
      } else if (text.includes("посмотреть демо")) {
        bindLeadTrigger(element, "demo");
      } else if (text.includes("начать трансформацию")) {
        bindLeadTrigger(element, "transformation");
      } else if (text.includes("связаться с нами")) {
        bindLeadTrigger(element, "enterprise");
      }
    });

    document.querySelector(".text-2xl.font-bold.bg-gradient-to-r")?.closest("div")?.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function repairPlaceholderLinks() {
    const replacements = new Map([
      ["интеграции", "#features"],
      ["api", "#pricing"],
      ["о нас", "#results"],
      ["блог", "#cases"],
      ["карьера", "#founder-call"],
      ["пресс-кит", "#founder-call"],
      ["база знаний", "#how-it-works"],
      ["вебинары", "#cases"],
      ["поддержка", "#founder-call"],
    ]);

    [...document.querySelectorAll('a[href="#"]')].forEach((anchor) => {
      const text = normalizedText(anchor.textContent);
      if (text.includes("связаться с нами")) {
        bindLeadTrigger(anchor, "enterprise");
        return;
      }
      if (text.includes("политика конфиденциальности")) {
        bindLegalTrigger(anchor, "privacy");
        return;
      }
      if (text.includes("условия использования")) {
        bindLegalTrigger(anchor, "terms");
        return;
      }
      if (text.includes("cookie")) {
        bindLegalTrigger(anchor, "cookies");
        return;
      }
      for (const [key, href] of replacements.entries()) {
        if (text.includes(key)) {
          anchor.setAttribute("href", href);
          if (href.startsWith("#")) {
            anchor.addEventListener("click", (event) => {
              event.preventDefault();
              scrollToTarget(href);
            });
          }
          return;
        }
      }
    });
  }

  function wireLegalModalInteractions() {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const opener = target.closest("[data-open-legal-modal]");
      if (opener) {
        event.preventDefault();
        const doc = opener.getAttribute("data-legal-doc") || "privacy";
        openLegalModal(doc);
        return;
      }

      if (target.closest("[data-close-legal-modal]")) {
        closeLegalModal();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.legalModalOpen) {
        closeLegalModal();
      }
    });
  }

  function wireModalInteractions() {
    const modal = document.querySelector(".aibeaty-modal");
    const form = document.getElementById("lead-form");
    const status = form?.querySelector(".aibeaty-form__status");

    if (!modal || !form || !status) {
      return;
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const opener = target.closest("[data-open-lead-modal]");
      if (opener) {
        event.preventDefault();
        const intent = opener.getAttribute("data-intent") || "audit";
        const source = opener.getAttribute("data-source") || "landing";
        openModal(intent, source);
        return;
      }

      if (target.closest("[data-close-modal]")) {
        closeModal();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.modalOpen) {
        closeModal();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitter = form.querySelector('button[type="submit"]');
      if (!(submitter instanceof HTMLButtonElement)) {
        return;
      }

      submitter.disabled = true;
      status.textContent = "Собираем заявку...";
      status.classList.remove("is-error", "is-success");

      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      payload.createdAt = new Date().toISOString();
      payload.page = window.location.href;

      try {
        persistLead(payload);

        if (CONFIG.webhookUrl) {
          await fetch(CONFIG.webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
        }

        deliverFallback(payload);
        status.textContent = "Заявка сохранена. Мы открыли fallback-доставку в почте и оставили копию в браузере.";
        status.classList.add("is-success");
        form.reset();
        form.elements.intent.value = state.activeIntent;
        form.elements.source.value = state.activeSource;
      } catch (error) {
        console.error(error);
        status.textContent = "Не удалось отправить автоматически. Данные заявки сохранены локально, можно повторить позже.";
        status.classList.add("is-error");
      } finally {
        submitter.disabled = false;
      }
    });

    const demoButton = form.querySelector("[data-book-demo]");
    demoButton?.addEventListener("click", () => {
      closeModal();
      if (CONFIG.calendlyUrl) {
        window.open(CONFIG.calendlyUrl, "_blank", "noopener");
      } else {
        scrollToTarget("#cases");
      }
    });
  }

  function bindLeadTrigger(element, intent) {
    element.setAttribute("data-open-lead-modal", "");
    element.setAttribute("data-intent", intent);
    element.setAttribute("data-source", deriveSource(element));
    element.addEventListener("click", (event) => {
      event.preventDefault();
      openModal(intent, deriveSource(element));
    });
  }

  function bindLegalTrigger(element, doc) {
    element.setAttribute("data-open-legal-modal", "");
    element.setAttribute("data-legal-doc", doc);
    element.setAttribute("href", "#");
    element.addEventListener("click", (event) => {
      event.preventDefault();
      openLegalModal(doc);
    });
  }

  function openModal(intent, source) {
    const modal = document.querySelector(".aibeaty-modal");
    const form = document.getElementById("lead-form");
    if (!modal || !form) {
      return;
    }

    state.activeIntent = intent;
    state.activeSource = source;
    state.modalOpen = true;

    form.elements.intent.value = intent;
    form.elements.source.value = source;

    const status = form.querySelector(".aibeaty-form__status");
    if (status) {
      status.textContent = "";
      status.classList.remove("is-error", "is-success");
    }

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("aibeaty-lock-scroll");

    const title = document.getElementById("lead-modal-title");
    if (title) {
      title.textContent = modalTitle(intent);
    }

    const goal = form.elements.goal;
    if (goal instanceof HTMLSelectElement) {
      if (["audit", "demo"].includes(intent)) {
        goal.value = intent;
      }
    }

    const firstInput = form.querySelector('input[name="name"]');
    if (firstInput instanceof HTMLInputElement) {
      window.setTimeout(() => firstInput.focus(), 40);
    }
  }

  function closeModal() {
    const modal = document.querySelector(".aibeaty-modal");
    if (!modal) {
      return;
    }
    state.modalOpen = false;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("aibeaty-lock-scroll");
  }

  function openLegalModal(docKey) {
    const modal = document.querySelector(".aibeaty-legal-modal");
    const documentMeta = LEGAL_DOCUMENTS[docKey] || LEGAL_DOCUMENTS.privacy;
    if (!modal || !documentMeta) {
      return;
    }

    state.legalModalOpen = true;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("aibeaty-lock-scroll");

    const title = document.getElementById("legal-modal-title");
    const updated = document.getElementById("legal-modal-updated");
    const body = document.getElementById("legal-modal-body");

    if (title) {
      title.textContent = documentMeta.title;
    }
    if (updated) {
      updated.textContent = `Актуально на ${documentMeta.updatedAt}`;
    }
    if (body) {
      body.innerHTML = documentMeta.body;
    }
  }

  function closeLegalModal() {
    const modal = document.querySelector(".aibeaty-legal-modal");
    if (!modal) {
      return;
    }
    state.legalModalOpen = false;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("aibeaty-lock-scroll");
  }

  function rewriteHeroSection() {
    const hero = document.querySelector("nav + section");
    if (!hero) {
      return;
    }

    const label = hero.querySelector(".inline-flex.items-center.gap-2");
    const title = hero.querySelector("h1");
    const description = hero.querySelector("p.text-xl.text-gray-600");
    const buttons = [...hero.querySelectorAll("button")];
    const stats = hero.querySelector(".flex.items-center.gap-8.mt-12");
    const floatingCards = hero.querySelectorAll(".absolute.top-8.right-8, .absolute.bottom-8.left-8");
    const brand = document.querySelector("nav .text-2xl.font-bold.bg-gradient-to-r");
    const navCases = [...document.querySelectorAll('nav a[href="#cases"]')];

    if (brand) {
      brand.textContent = "AIbeaty";
    }
    navCases.forEach((anchor) => {
      anchor.textContent = "Кому подходит";
    });

    if (label) {
      label.innerHTML = `<span class="aibeaty-chip">AI operating system for beauty businesses</span>`;
    }
    if (title) {
      title.innerHTML = `<span class="bg-gradient-to-r from-pink-600 to-purple-600 bg-clip-text text-transparent">AIbeaty</span><br>собирает лиды,<br>follow-up и rebooking`;
    }
    if (description) {
      description.textContent = "Для салонов, сетей, клиник и spa-команд, где заявки приходят из сайта, WhatsApp, Instagram и мессенджеров, а владелец хочет единый рабочий контур вместо ручного хаоса.";
    }

    if (buttons[0]) {
      buttons[0].innerHTML = `Запросить AI-аудит<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right w-5 h-5"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>`;
    }
    if (buttons[1]) {
      buttons[1].innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play w-5 h-5"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>Заказать демо`;
    }

    if (stats) {
      stats.className = "aibeaty-hero-fit";
      stats.innerHTML = `
        <article class="aibeaty-hero-fit__card">
          <strong>Салоны и клиники</strong>
          <span>Где нужно не терять входящие и быстрее доводить до записи.</span>
        </article>
        <article class="aibeaty-hero-fit__card">
          <strong>Сети и управляющие команды</strong>
          <span>Где важны единые процессы, контроль воронки и прозрачность по точкам.</span>
        </article>
        <article class="aibeaty-hero-fit__card">
          <strong>Spa и premium сервис</strong>
          <span>Где повторные визиты, загрузка расписания и персональный follow-up критичны.</span>
        </article>
      `;
    }

    if (floatingCards[0]) {
      floatingCards[0].innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-gradient-to-br from-pink-500 to-purple-600 rounded-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-inbox w-6 h-6 text-white"><path d="M22 12h-4l-3 3H9l-3-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
          </div>
          <div>
            <div class="text-xs text-gray-500">Единый входящий поток</div>
            <div class="font-bold">Сайт, мессенджеры и заявки в одном контуре</div>
          </div>
        </div>
      `;
    }
    if (floatingCards[1]) {
      floatingCards[1].innerHTML = `
        <div class="text-xs text-gray-500 mb-1">Операционный эффект</div>
        <div class="font-bold text-gray-900">Меньше потерянных лидов и ручного follow-up</div>
      `;
    }
  }

  function rewriteResultsSection() {
    const section = [...document.querySelectorAll("section")].find((item) =>
      normalizedText(item.textContent).includes("реальные результаты для вашего бизнеса")
    );

    if (!section) {
      return;
    }

    section.id = "results";
    section.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid lg:grid-cols-2 gap-12 items-center">
          <div class="relative order-2 lg:order-1">
            <div class="relative rounded-3xl overflow-hidden shadow-2xl">
              <img src="./assets/img/spa.jpg" alt="Beauty operations dashboard" class="w-full h-auto">
            </div>
            <div class="absolute -bottom-8 -right-8 w-64 h-64 bg-gradient-to-br from-pink-400 to-purple-500 rounded-full blur-3xl opacity-30 -z-10"></div>
          </div>
          <div class="order-1 lg:order-2">
            <h2 class="text-4xl sm:text-5xl font-bold mb-6">Что именно <span class="bg-gradient-to-r from-pink-600 to-purple-600 bg-clip-text text-transparent">закрывает AIbeaty</span></h2>
            <p class="text-xl text-gray-600 mb-8 leading-relaxed">Без выдуманных обещаний. Система лучше всего работает там, где уже есть спрос, но часть денег теряется между первым сообщением, записью, визитом и возвратом клиента.</p>
            <div class="space-y-4">
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check w-6 h-6 text-pink-600 flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span class="text-gray-700 text-lg">Собирает обращения из нескольких каналов в один рабочий поток.</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check w-6 h-6 text-pink-600 flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span class="text-gray-700 text-lg">Автоматизирует первичный ответ, follow-up и возврат клиентов на повторную запись.</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check w-6 h-6 text-pink-600 flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span class="text-gray-700 text-lg">Дает owner и управляющему видимость по pipeline, загрузке и точкам просадки.</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check w-6 h-6 text-pink-600 flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span class="text-gray-700 text-lg">Снижает зависимость от ручных напоминаний, чатов и разрозненных таблиц.</span></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function rewriteCasesSection() {
    const section = document.getElementById("cases");
    if (!section) {
      return;
    }

    section.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-16">
          <h2 class="text-4xl sm:text-5xl font-bold mb-4">Кому <span class="bg-gradient-to-r from-pink-600 to-purple-600 bg-clip-text text-transparent">лучше всего подходит</span> AIbeaty</h2>
          <p class="text-xl text-gray-600 max-w-3xl mx-auto">Не секция с выдуманными отзывами, а честная карта бизнесов, где система обычно дает максимальный эффект.</p>
        </div>
        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          <article class="aibeaty-fit-card">
            <div class="aibeaty-fit-card__media"><img src="./assets/img/products.jpg" alt="Beauty retail and product business" class="w-full h-full object-cover"></div>
            <div class="aibeaty-fit-card__body">
              <div class="aibeaty-fit-card__eyebrow">Салоны и студии</div>
              <h3>Где лиды приходят в мессенджеры, а запись все еще держится на администраторе</h3>
              <p>AIbeaty помогает не терять входящие, ускорять ответ и выстраивать предсказуемый follow-up.</p>
            </div>
          </article>
          <article class="aibeaty-fit-card">
            <div class="aibeaty-fit-card__media"><img src="./assets/img/makeup.jpg" alt="Beauty chain operations" class="w-full h-full object-cover"></div>
            <div class="aibeaty-fit-card__body">
              <div class="aibeaty-fit-card__eyebrow">Сети и управляющие компании</div>
              <h3>Где важны единый стандарт коммуникации, контроль по точкам и управляемая загрузка</h3>
              <p>Подходит командам, которые хотят видеть pipeline целиком, а не собирать статусы вручную по филиалам.</p>
            </div>
          </article>
          <article class="aibeaty-fit-card">
            <div class="aibeaty-fit-card__media"><img src="./assets/img/lab.jpg" alt="Clinic and spa follow-up" class="w-full h-full object-cover"></div>
            <div class="aibeaty-fit-card__body">
              <div class="aibeaty-fit-card__eyebrow">Клиники, косметология, spa</div>
              <h3>Где повторные визиты, дорогие процедуры и возврат клиента важнее красивой витрины</h3>
              <p>AIbeaty помогает держать в контуре повторные записи, напоминания и персональные сценарии возврата.</p>
            </div>
          </article>
        </div>
      </div>
    `;
  }

  function rewritePricingSection() {
    const section = document.getElementById("pricing");
    if (!section) {
      return;
    }

    section.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-16">
          <h2 class="text-4xl sm:text-5xl font-bold mb-4">Прозрачные <span class="bg-gradient-to-r from-pink-600 to-purple-600 bg-clip-text text-transparent">тарифы</span></h2>
          <p class="text-xl text-gray-600 max-w-3xl mx-auto">Все планы включают 14-дневный пробный период. Цены указаны в долларах США.</p>
        </div>
        <div class="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          <div class="relative bg-white rounded-3xl p-8 border-2 border-gray-200 hover:border-pink-200 transition-all duration-300">
            <div class="w-14 h-14 bg-gradient-to-br from-pink-500 to-rose-500 rounded-2xl flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles w-7 h-7 text-white"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path><path d="M4 17v2"></path><path d="M5 18H3"></path></svg>
            </div>
            <h3 class="text-2xl font-bold mb-2">Starter</h3>
            <p class="text-gray-600 mb-6">Для одной точки или компактной студии.</p>
            <div class="mb-6"><div class="flex items-baseline gap-2"><span class="text-4xl font-bold">$149</span></div><div class="text-gray-500">/ month</div></div>
            <button class="w-full py-4 rounded-full font-semibold mb-8 transition-all bg-gray-100 text-gray-900 hover:bg-gray-200">Начать бесплатно</button>
            <div class="space-y-4">
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Lead capture и единый inbox</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Базовый follow-up и rebooking</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Owner dashboard</span></div>
            </div>
          </div>
          <div class="relative bg-white rounded-3xl p-8 border-2 border-transparent shadow-2xl shadow-pink-500/20 scale-105 transition-all duration-300">
            <div class="absolute -top-4 left-1/2 transform -translate-x-1/2"><div class="bg-gradient-to-r from-pink-600 to-purple-600 text-white px-6 py-2 rounded-full text-sm font-semibold">Most practical</div></div>
            <div class="w-14 h-14 bg-gradient-to-br from-pink-600 to-purple-600 rounded-2xl flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-rocket w-7 h-7 text-white"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg>
            </div>
            <h3 class="text-2xl font-bold mb-2">Growth</h3>
            <p class="text-gray-600 mb-6">Для растущих салонов и multi-location команд.</p>
            <div class="mb-6"><div class="flex items-baseline gap-2"><span class="text-4xl font-bold">$349</span></div><div class="text-gray-500">/ month</div></div>
            <button class="w-full py-4 rounded-full font-semibold mb-8 transition-all bg-gradient-to-r from-pink-600 to-purple-600 text-white">Запросить демо</button>
            <div class="space-y-4">
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Все из Starter</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Сценарии follow-up по сегментам</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Отчеты для owner и управляющего</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Базовые интеграции и onboarding</span></div>
            </div>
          </div>
          <div class="relative bg-white rounded-3xl p-8 border-2 border-gray-200 hover:border-pink-200 transition-all duration-300">
            <div class="w-14 h-14 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-2xl flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-building-2 w-7 h-7 text-white"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"></path><path d="M6 12H4a2 2 0 0 0-2 2v8h4"></path><path d="M18 9h2a2 2 0 0 1 2 2v11h-4"></path><path d="M10 6h4"></path><path d="M10 10h4"></path><path d="M10 14h4"></path><path d="M10 18h4"></path></svg>
            </div>
            <h3 class="text-2xl font-bold mb-2">Enterprise</h3>
            <p class="text-gray-600 mb-6">Для сетей, клиник и custom rollout.</p>
            <div class="mb-6"><div class="flex items-baseline gap-2"><span class="text-3xl font-bold">Custom</span></div></div>
            <button class="w-full py-4 rounded-full font-semibold mb-8 transition-all bg-gray-100 text-gray-900 hover:bg-gray-200">Связаться с нами</button>
            <div class="space-y-4">
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Custom integrations и rollout plan</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Multi-location governance</span></div>
              <div class="flex items-start gap-3"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check w-5 h-5 text-pink-600 flex-shrink-0 mt-0.5"><path d="M20 6 9 17l-5-5"></path></svg><span class="text-gray-700">Dedicated support и SLA</span></div>
            </div>
          </div>
        </div>
        <div class="text-center mt-12"><p class="text-gray-600">Нужен нестандартный rollout или подключение в CRM? <a href="#" class="text-pink-600 hover:text-purple-600 font-semibold">Свяжитесь с нами</a></p></div>
      </div>
    `;
  }

  function rewriteFinalCtaSection() {
    const section = [...document.querySelectorAll("section")].find((item) =>
      normalizedText(item.textContent).includes("готовы трансформировать ваш бьюти-бизнес")
    );

    if (!section) {
      return;
    }

    section.id = "contact";
    section.querySelector(".text-sm.text-white")?.closest(".inline-flex")?.replaceChildren();

    const title = section.querySelector("h2");
    const description = section.querySelector("p.text-xl");
    const buttons = [...section.querySelectorAll("button")];
    const trustRow = section.querySelector(".mt-8.flex.items-center.gap-8.text-white");
    const badge = section.querySelector(".inline-flex.items-center.gap-2");

    if (title) {
      title.textContent = "Готовы проверить AIbeaty на вашем потоке заявок?";
    }
    if (badge) {
      badge.innerHTML = `<span class="text-sm text-white">Trial access</span>`;
    }
    if (description) {
      description.textContent = "Дадим 14 дней trial, покажем demo flow и соберем план запуска под ваш формат бизнеса без выдуманных обещаний и без карты на старте.";
    }
    if (buttons[0]) {
      buttons[0].innerHTML = `Начать 14-дневный trial<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right w-5 h-5"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>`;
    }
    if (buttons[1]) {
      buttons[1].textContent = "Заказать демо";
    }
    if (trustRow) {
      trustRow.className = "aibeaty-cta-facts";
      trustRow.innerHTML = `
        <div class="aibeaty-cta-facts__item">14 дней trial</div>
        <div class="aibeaty-cta-facts__item">Без карты на старте</div>
        <div class="aibeaty-cta-facts__item">Можно подключить webhook / CRM / n8n</div>
      `;
    }
  }

  function rewriteFooterSection() {
    const footer = document.querySelector("footer");
    if (!footer) {
      return;
    }

    const brand = footer.querySelector(".text-2xl.font-bold");
    const about = footer.querySelector(".text-gray-400.mb-6.max-w-xs");
    const socialRow = footer.querySelector(".flex.gap-4");
    const credit = [...footer.querySelectorAll("p.text-gray-400.text-sm")];
    const columns = [...footer.querySelectorAll("h4.font-semibold.mb-4")];
    const grid = footer.querySelector(".grid.md\\:grid-cols-2.lg\\:grid-cols-6.gap-8.mb-12");

    if (brand) {
      brand.textContent = "AIbeaty";
    }
    if (about) {
      about.textContent = "AIbeaty помогает beauty-бизнесу не терять лиды, выстраивать follow-up и делать повторные записи управляемым процессом.";
    }
    if (socialRow) {
      socialRow.className = "aibeaty-footer-notes";
      socialRow.innerHTML = `
        <span>hello@aibeaty.ai</span>
        <span>14-day trial</span>
        <span>Founder-led onboarding</span>
      `;
    }
    if (grid && columns.length >= 4) {
      const productColumn = columns[0].parentElement;
      const companyColumn = columns[1].parentElement;
      const resourcesColumn = columns[2].parentElement;

      if (productColumn) {
        productColumn.innerHTML = `
          <h4 class="font-semibold mb-4">Продукт</h4>
          <ul class="space-y-2">
            <li><a href="#features" class="text-gray-400 hover:text-white transition-colors">Возможности</a></li>
            <li><a href="#how-it-works" class="text-gray-400 hover:text-white transition-colors">Как работает</a></li>
            <li><a href="#cases" class="text-gray-400 hover:text-white transition-colors">Кому подходит</a></li>
            <li><a href="#pricing" class="text-gray-400 hover:text-white transition-colors">Тарифы</a></li>
          </ul>
        `;
      }

      if (companyColumn) {
        companyColumn.innerHTML = `
          <h4 class="font-semibold mb-4">Контакт</h4>
          <ul class="space-y-2">
            <li><a href="#founder-call" class="text-gray-400 hover:text-white transition-colors">Связаться с нами</a></li>
            <li><a href="#contact" class="text-gray-400 hover:text-white transition-colors">Запросить демо</a></li>
            <li><a href="#results" class="text-gray-400 hover:text-white transition-colors">Что закрывает AIbeaty</a></li>
          </ul>
        `;
      }

      if (resourcesColumn) {
        resourcesColumn.innerHTML = `
          <h4 class="font-semibold mb-4">Запуск</h4>
          <ul class="space-y-2">
            <li><a href="#contact" class="text-gray-400 hover:text-white transition-colors">14-дневный trial</a></li>
            <li><a href="#pricing" class="text-gray-400 hover:text-white transition-colors">Планы и цены</a></li>
            <li><a href="#founder-call" class="text-gray-400 hover:text-white transition-colors">Founder-led onboarding</a></li>
          </ul>
        `;
      }
    }
    if (credit[0]) {
      credit[0].textContent = "© 2026 AIbeaty. Все права защищены.";
    }
    if (credit[1]) {
      credit[1].textContent = "Сделано для beauty-бизнесов, которым нужен рабочий AI-контур, а не витринный слайд.";
    }
  }

  function deliverFallback(payload) {
    if (!CONFIG.leadEmail) {
      return;
    }

    const subject = `[AIbeaty] ${payload.intent} - ${payload.business || payload.name}`;
    const body = [
      `Intent: ${payload.intent}`,
      `Source: ${payload.source}`,
      `Name: ${payload.name}`,
      `Business: ${payload.business}`,
      `City: ${payload.city || "-"}`,
      `Phone: ${payload.phone}`,
      `Email: ${payload.email}`,
      `Goal: ${payload.goal}`,
      `Notes: ${payload.notes || "-"}`,
      `Created at: ${payload.createdAt}`,
      `Page: ${payload.page}`,
    ].join("\n");

    const href = `mailto:${encodeURIComponent(CONFIG.leadEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }

  function persistLead(payload) {
    const key = "aibeaty_lead_queue";
    const existing = JSON.parse(window.localStorage.getItem(key) || "[]");
    existing.push(payload);
    window.localStorage.setItem(key, JSON.stringify(existing));
  }

  function deriveSource(element) {
    if (element.closest("nav")) {
      return "nav";
    }
    if (element.closest("#pricing")) {
      return "pricing";
    }
    if (element.closest("#cases")) {
      return "cases";
    }
    if (element.closest("#how-it-works")) {
      return "how_it_works";
    }
    return "landing";
  }

  function scrollToTarget(selector) {
    const target = document.querySelector(selector);
    if (!target) {
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function modalTitle(intent) {
    switch (intent) {
      case "demo":
        return "Заказать demo flow для салона";
      case "enterprise":
        return "Связаться по Enterprise внедрению";
      case "transformation":
        return "Запустить AI-трансформацию салона";
      default:
        return "Запросить AI-аудит для салона";
    }
  }

  function normalizedText(value) {
    return (value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }
})();
