/* AIbeaty SEO pages — shared nav + lead form behavior (progressive enhancement). */
(function () {
  "use strict";

  // Mobile nav toggle
  var toggle = document.querySelector("[data-nav-toggle]");
  var nav = document.querySelector("[data-nav]");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("aib-nav--open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Lead form (UI-only fallback; posts to webhook if configured)
  var CONFIG = Object.assign(
    { webhookUrl: "", leadEmail: "hello@aibeaty.ai" },
    window.AIBEATY_CONFIG || {}
  );

  document.querySelectorAll("form[data-lead-form]").forEach(function (form) {
    var status = form.querySelector(".aib-form__status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (status) {
        status.textContent = "";
        status.className = "aib-form__status";
      }
      var data = Object.fromEntries(new FormData(form).entries());
      if (!data.name || !data.contact) {
        if (status) {
          status.textContent = "Укажите имя и контакт для связи.";
          status.className = "aib-form__status is-err";
        }
        return;
      }
      data.page = location.pathname;
      data.submittedAt = new Date().toISOString();

      function ok() {
        if (status) {
          status.textContent =
            "Заявка отправлена. Свяжемся в течение рабочего дня.";
          status.className = "aib-form__status is-ok";
        }
        form.reset();
      }

      if (CONFIG.webhookUrl) {
        fetch(CONFIG.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
          .then(function (r) {
            if (!r.ok) throw new Error("bad status");
            ok();
          })
          .catch(function () {
            if (status) {
              status.textContent =
                "Не удалось отправить автоматически. Напишите на " +
                CONFIG.leadEmail;
              status.className = "aib-form__status is-err";
            }
          });
      } else {
        ok();
      }
    });
  });
})();
