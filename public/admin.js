// public/admin.js
// MostlyPostly Admin — Modal Controller + Template Loader

console.log("[Admin] admin.js loaded");

// ─── CSRF helper ────────────────────────────────────────────────
// Read the token injected by the server into <meta name="csrf-token">
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content || "";
}

// Patch fetch so all same-origin POST/PUT/PATCH/DELETE requests
// automatically include the CSRF token header.
(function patchFetch() {
  const _fetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const mutating = ["POST", "PUT", "PATCH", "DELETE"];
    const isSameOrigin =
      typeof input === "string"
        ? input.startsWith("/") || input.startsWith(window.location.origin)
        : true;
    if (mutating.includes(method) && isSameOrigin) {
      init.headers = Object.assign({}, init.headers, {
        "X-CSRF-Token": getCsrfToken(),
      });
    }
    return _fetch(input, init);
  };
})();

// Global admin controller namespace
window.admin = {
  templates: {},
  loaded: false,


  // -----------------------------------------
  // Load all HTML templates once on page load
  // -----------------------------------------
  loadTemplates() {
    if (this.loaded) return;

    const all = document.querySelectorAll("#admin-modal-templates template");
    if (!all.length) {
      console.error("[Admin] No templates found in #admin-modal-templates.");
      return;
    }

    all.forEach((tpl) => {
      this.templates[tpl.id] = tpl.innerHTML;
    });

    this.loaded = true;
    console.log("[Admin] Templates loaded:", Object.keys(this.templates));
  },

  // -----------------------------------------
  // Open a modal by template ID
  // -----------------------------------------
  async openModal(templateId) {
    this.loadTemplates();
    const html = this.templates[templateId];
    if (!html) {
      console.error("Template not found:", templateId);
      return;
    }

    const modal = document.querySelector("#admin-modal");
    const backdrop = document.querySelector("#admin-modal-backdrop");
    const panel = document.querySelector("#admin-modal-content");

    // Reset modal width to default before each open
    const modalPanel = document.querySelector("#admin-modal-panel");
    if (modalPanel) {
      modalPanel.classList.remove("max-w-2xl");
      modalPanel.classList.add("max-w-lg");
    }

    // Replace {{placeholders}} using adminData
    const populated = html.replace(/{{(.*?)}}/g, (match, key) => {
      key = key.trim();
      return window.adminData[key] ?? "";
    });

    panel.innerHTML = populated;
    modal.classList.remove("hidden");
    backdrop.classList.remove("hidden");

    // --- FORCE X BUTTON TO BE ON TOP ---
    const closeBtn = document.querySelector("#admin-modal-close");
    if (closeBtn) {
      closeBtn.style.zIndex = "99999";
      closeBtn.style.position = "absolute";
      closeBtn.style.top = "14px";
      closeBtn.style.right = "14px";
      closeBtn.style.pointerEvents = "auto";
    }

    backdrop.onclick = () => this.closeModal();
    document.onkeydown = (e) => {
      if (e.key === "Escape") this.closeModal();
    };

    return panel; // allow initialization
  },

  // -----------------------------------------
  closeModal() {
    const modal = document.querySelector("#admin-modal");
    const backdrop = document.querySelector("#admin-modal-backdrop");
    const panel = document.querySelector("#admin-modal-content");

    panel.innerHTML = "";
    modal.classList.add("hidden");
    backdrop.classList.add("hidden");
  },

  // -----------------------------------------
  // Salon Info Modal
  // -----------------------------------------
  async openSalonInfo() {
    const panel = await this.openModal("tpl-edit-salon-info");
    if (!panel) return;

    const data = window.adminData;

    // Fill fields
    [
      "salon_id",
      "name",
      "address",
      "city",
      "state",
      "zip",
      "website",
      "booking_url",
      "industry",
      "timezone",
      "tone_profile",
    ].forEach((key) => {
      const el = panel.querySelector(`[data-field='${key}']`);
      if (el) el.value = data[key] || "";
    });

  },

  // -----------------------------------------
  // Posting Rules Modal (per-day schedule)
  // -----------------------------------------
  async openPostingRules() {
    const panel = await this.openModal("tpl-posting-rules");
    if (!panel) return;

    const data = window.adminData;

    // Fill spacing
    ["spacing_min", "spacing_max"].forEach((key) => {
      const el = panel.querySelector(`[data-field='${key}']`);
      if (el) el.value = data[key] ?? "";
    });

    // Build time options (every 30 min, midnight through 11:30 PM)
    function buildTimeOptions(selectedVal) {
      const options = [];
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 30) {
          const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          const ampm = h < 12 ? "AM" : "PM";
          const minStr = m === 0 ? "00" : "30";
          const label = `${hour12}:${minStr} ${ampm}`;
          const sel = val === selectedVal ? " selected" : "";
          options.push(`<option value="${val}"${sel}>${label}</option>`);
        }
      }
      return options.join("");
    }

    const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
    const DAY_LABELS = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
    const schedule = data.posting_schedule || {};
    const grid = panel.querySelector("#posting-days-grid");
    const hidden = panel.querySelector("#posting-schedule-json");
    const form = panel.querySelector("#posting-rules-form");

    function syncHidden() {
      const result = {};
      DAYS.forEach(day => {
        const row = grid.querySelector(`[data-day="${day}"]`);
        if (!row) return;
        result[day] = {
          enabled: row.querySelector(".day-toggle").checked,
          start:   row.querySelector(".day-start").value,
          end:     row.querySelector(".day-end").value,
        };
      });
      hidden.value = JSON.stringify(result);
    }

    function renderGrid() {
      grid.innerHTML = DAYS.map(day => {
        const cfg = schedule[day] || { enabled: true, start: "09:00", end: "20:00" };
        const disabledClass = cfg.enabled ? "" : "opacity-40 pointer-events-none";
        return `
          <div data-day="${day}" class="flex items-center gap-2 rounded-lg p-2 bg-gray-50 border border-gray-200">
            <label class="flex items-center gap-1.5 cursor-pointer min-w-[52px]">
              <input type="checkbox" class="day-toggle accent-mpAccent cursor-pointer" ${cfg.enabled ? "checked" : ""} />
              <span class="text-xs font-semibold text-mpCharcoal">${DAY_LABELS[day]}</span>
            </label>
            <div class="flex items-center gap-1 flex-1 ${disabledClass}">
              <select class="day-start flex-1 border border-gray-200 bg-white rounded px-2 py-1 text-xs text-mpCharcoal focus:border-mpAccent focus:outline-none">
                ${buildTimeOptions(cfg.start)}
              </select>
              <span class="text-xs text-mpMuted">–</span>
              <select class="day-end flex-1 border border-gray-200 bg-white rounded px-2 py-1 text-xs text-mpCharcoal focus:border-mpAccent focus:outline-none">
                ${buildTimeOptions(cfg.end)}
              </select>
            </div>
          </div>`;
      }).join("");

      // Toggle handler — enable/disable time pickers
      DAYS.forEach(day => {
        const row = grid.querySelector(`[data-day="${day}"]`);
        const toggle = row.querySelector(".day-toggle");
        const timesDiv = row.querySelector(".flex-1");
        toggle.addEventListener("change", () => {
          timesDiv.classList.toggle("opacity-40", !toggle.checked);
          timesDiv.classList.toggle("pointer-events-none", !toggle.checked);
        });
      });
    }

    renderGrid();
    syncHidden();
    form.addEventListener("submit", syncHidden);
  },

  // -----------------------------------------
  // Manager Rules Modal
  // -----------------------------------------
  async openManagerRules() {
    const panel = await this.openModal("tpl-manager-rules");
    if (!panel) return;

    const data = window.adminData;

    // Populate all manager rule fields
    [
      "salon_id",
      "require_manager_approval",
      "auto_publish",
      "notify_on_approval",
      "notify_on_denial"
    ].forEach((key) => {
      const el = panel.querySelector(`[data-field='${key}']`);
      if (el) el.value = data[key] ? "1" : "0";
    });
  },

  // -----------------------------------------
  // Hashtags Modal
  // -----------------------------------------
  async openHashtags() {
    const panel = await this.openModal("tpl-hashtags");
    if (!panel) return;

    const data = window.adminData;

    // Salon tag display (locked)
    const tagBox = panel.querySelector("[data-field='salon_tag_display']");
    if (tagBox) tagBox.textContent = data.salon_tag || "";

    const hidden  = panel.querySelector("#hashtags-json");
    const chips   = panel.querySelector("#hashtags-chips");
    const inputEl = panel.querySelector("#hashtag-input");
    const addBtn  = panel.querySelector("#hashtag-add-btn");
    const form    = panel.querySelector("#hashtags-form");

    let tags = data.custom_hashtags ? [...data.custom_hashtags].slice(0, 2) : [];

    function normalize(raw) {
      return "#" + raw.trim().replace(/^#+/, "");
    }

    function sync() {
      hidden.value = JSON.stringify(tags);
    }

    function renderChips() {
      chips.innerHTML = "";
      tags.forEach((tag, idx) => {
        const chip = document.createElement("div");
        chip.className = "inline-flex items-center gap-1.5 rounded-full bg-mpAccentLight border border-mpBorder pl-3 pr-1.5 py-1 text-xs font-medium text-mpCharcoal";

        const lbl = document.createElement("span");
        lbl.textContent = tag;
        chip.appendChild(lbl);

        // Move up
        if (idx > 0) {
          const up = document.createElement("button");
          up.type = "button";
          up.textContent = "↑";
          up.className = "text-mpMuted hover:text-mpCharcoal text-[10px] leading-none px-0.5";
          up.onclick = () => { [tags[idx-1], tags[idx]] = [tags[idx], tags[idx-1]]; sync(); renderChips(); };
          chip.appendChild(up);
        }

        // Move down
        if (idx < tags.length - 1) {
          const down = document.createElement("button");
          down.type = "button";
          down.textContent = "↓";
          down.className = "text-mpMuted hover:text-mpCharcoal text-[10px] leading-none px-0.5";
          down.onclick = () => { [tags[idx], tags[idx+1]] = [tags[idx+1], tags[idx]]; sync(); renderChips(); };
          chip.appendChild(down);
        }

        // Remove
        const rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "×";
        rm.className = "text-mpMuted hover:text-red-500 text-sm leading-none ml-0.5";
        rm.onclick = () => { tags.splice(idx, 1); sync(); renderChips(); };
        chip.appendChild(rm);

        chips.appendChild(chip);
      });
    }

    function addTag() {
      const val = normalize(inputEl.value);
      if (val === "#" || tags.length >= 2) return;
      if (!tags.includes(val)) { tags.push(val); sync(); renderChips(); }
      inputEl.value = "";
    }

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") {
        if (inputEl.value.trim()) { e.preventDefault(); addTag(); }
      }
    });
    addBtn.addEventListener("click", addTag);

    // Sync hidden field right before form submits — include salon tag first
    form.addEventListener("submit", () => {
      const salonTagVal = data.salon_tag;
      const full = salonTagVal ? [salonTagVal, ...tags] : [...tags];
      hidden.value = JSON.stringify(full);
    });

    sync();
    renderChips();
  },

  // -----------------------------------------
  // Add Stylist Modal
  // -----------------------------------------
  async openAddStylist() {
    const panel = await this.openModal("tpl-add-stylist");
    if (!panel) return;

    const data = window.adminData;
    const salonIdEl = panel.querySelector("[data-field='salon_id']");
    salonIdEl.value = data.salon_id;

    const rows = panel.querySelector("#specialties-rows");
    const hidden = panel.querySelector("#specialties-json");

    let specs = [""];

    function render() {
      rows.innerHTML = "";
      specs.forEach((val, idx) => {
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        const input = document.createElement("input");
        input.className =
          "flex-1 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-800";
        input.value = val;
        input.oninput = () => {
          specs[idx] = input.value;
          syncHidden();
        };

        const add = document.createElement("button");
        add.textContent = "+";
        add.className =
          "px-2 py-1 rounded-full border border-gray-200 bg-white text-gray-700 text-xs hover:bg-gray-50";
        add.onclick = () => {
          if (specs.length < 5) {
            specs.push("");
            render();
            syncHidden();
          }
        };

        const remove = document.createElement("button");
        remove.textContent = "×";
        remove.className =
          "px-2 py-1 rounded-full border border-gray-200 bg-white text-gray-500 text-xs hover:text-red-500 hover:border-red-200";
        remove.onclick = () => {
          specs.splice(idx, 1);
          render();
          syncHidden();
        };

        row.appendChild(input);
        row.appendChild(add);
        row.appendChild(remove);
        rows.appendChild(row);
      });
      syncHidden();
    }

    function syncHidden() {
      hidden.value = JSON.stringify(
        specs.map((x) => x.trim()).filter(Boolean).slice(0, 5)
      );
    }

    render();
  },

    // -----------------------------------------
    // Delete Member Handler
    // -----------------------------------------
    deleteMember(id, salonId) {
      if (!confirm("Are you sure you want to delete this member? This cannot be undone.")) {
        return;
      }

      // Redirect to backend delete route
      window.location.href = `/manager/admin/delete-stylist?id=${id}&salon=${salonId}`;
    },

    deleteCurrentMember() {
    const panel = document.querySelector("#admin-modal");
    const idEl = panel.querySelector("[data-field='id']");
    const salonEl = panel.querySelector("[data-field='salon_id']");

    const id = idEl?.value || "";
    const salon = salonEl?.value || "";

    if (!id || !salon) {
      alert("Missing member ID or salon ID");
      console.error("Delete Error: ", { id, salon });
      return;
    }

    if (!confirm("Are you sure you want to delete this member? This cannot be undone.")) {
      return;
    }

    window.location.href = `/manager/admin/delete-stylist?id=${id}&salon=${salon}`;
  },


    // -----------------------------------------
    // Edit Stylist Modal
    // -----------------------------------------
    async openEditStylist(payload) {
      const panel = await this.openModal("tpl-edit-stylist");
      if (!panel) return;

      // Widen the modal for the richer content
      const modalPanel = document.querySelector("#admin-modal-panel");
      if (modalPanel) {
        modalPanel.classList.remove("max-w-lg");
        modalPanel.classList.add("max-w-2xl");
      }

      const data = window.adminData || {};

      // ---- Basic hidden + text fields ----
      const fill = (sel, val) => { const el = panel.querySelector(sel); if (el) el.value = val || ""; };
      fill("[data-field='salon_id']", data.salon_id);
      fill("[data-field='id']",       payload.id);
      fill("[data-field='name']",     payload.name);
      fill("[data-field='phone']",    payload.phone);
      fill("[data-field='instagram_handle']", payload.instagram);


      // ---- Specialties ----
      const rows   = panel.querySelector("#edit-specialties-rows");
      const hidden = panel.querySelector("#edit-specialties-json");

      let specs = Array.isArray(payload.specialties) && payload.specialties.length
        ? payload.specialties.map(t => String(t || "").trim()).filter(Boolean).slice(0, 5)
        : [""];

      function syncHidden() {
        if (hidden) hidden.value = JSON.stringify(
          specs.map(x => String(x || "").trim()).filter(Boolean).slice(0, 5)
        );
      }

      function renderSpecs() {
        if (!rows) return;
        rows.innerHTML = "";
        specs.forEach((val, idx) => {
          const row = document.createElement("div");
          row.className = "flex items-center gap-2";

          const input = document.createElement("input");
          input.type = "text";
          input.className = "flex-1 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-800";
          input.value = val || "";
          input.placeholder = "specialty";
          input.addEventListener("input", () => { specs[idx] = input.value; syncHidden(); });

          const addBtn = document.createElement("button");
          addBtn.type = "button"; addBtn.textContent = "+";
          addBtn.className = "px-2 py-1 rounded-full border border-gray-200 bg-white text-gray-700 text-xs hover:bg-gray-50";
          addBtn.addEventListener("click", () => { if (specs.length < 5) { specs.push(""); renderSpecs(); syncHidden(); } });

          const removeBtn = document.createElement("button");
          removeBtn.type = "button"; removeBtn.textContent = "×";
          removeBtn.className = "px-2 py-1 rounded-full border border-gray-200 bg-white text-gray-500 text-xs hover:text-red-500 hover:border-red-200";
          removeBtn.addEventListener("click", () => {
            specs.splice(idx, 1);
            if (specs.length === 0) specs.push("");
            renderSpecs(); syncHidden();
          });

          row.appendChild(input); row.appendChild(addBtn); row.appendChild(removeBtn);
          rows.appendChild(row);
        });
        syncHidden();
      }
      renderSpecs();

      // ---- Resend Welcome button ----
      const resendBtn = panel.querySelector("#resend-welcome-btn");
      if (resendBtn) {
        resendBtn.addEventListener("click", async () => {
          resendBtn.disabled = true;
          resendBtn.textContent = "Sending…";
          try {
            const r = await fetch(`/manager/admin/resend-welcome/${payload.id}`, { method: "POST" });
            const json = await r.json();
            resendBtn.textContent = json.ok ? "Sent ✓" : "Failed";
          } catch {
            resendBtn.textContent = "Failed";
          }
          setTimeout(() => { resendBtn.disabled = false; resendBtn.textContent = "Resend Welcome"; }, 3000);
        });
      }

      // ---- Fetch full profile (photo + stock photos) ----
      try {
        const resp = await fetch(`/manager/admin/stylist/${payload.id}`);
        if (!resp.ok) throw new Error("Not found");
        const full = await resp.json();

        // Profile photo preview
        const photoPreview = panel.querySelector("#edit-stylist-photo-preview");
        if (photoPreview && full.photo_url) {
          photoPreview.innerHTML = `
            <div class="flex items-center gap-3 mb-2">
              <img src="${full.photo_url}" class="w-16 h-16 rounded-lg object-cover border border-slate-700" />
              <span class="text-xs text-slate-400">Current photo — upload a new one to replace</span>
            </div>`;
        }

        // Update specialties from server (more reliable than inline data attrs)
        if (Array.isArray(full.specialties) && full.specialties.length) {
          specs = full.specialties.map(t => String(t || "").trim()).filter(Boolean).slice(0, 5);
          if (specs.length === 0) specs = [""];
          renderSpecs();
        }

      } catch (err) {
        console.warn("[Admin] Stylist fetch failed:", err);
      }
    },

    // -----------------------------------------
    // Delete a stock photo from the edit modal
    // -----------------------------------------
    deleteStockPhoto(photoId, salonId) {
      if (!confirm("Remove this stock photo?")) return;
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `/manager/admin/stock-photos/delete?salon=${encodeURIComponent(salonId)}`;
      const inp = document.createElement("input");
      inp.type = "hidden"; inp.name = "photo_id"; inp.value = photoId;
      form.appendChild(inp);
      document.body.appendChild(form);
      form.submit();
    },
};

// -----------------------------------------
// CLICK HANDLERS FOR STYLIST EDIT BUTTONS
// -----------------------------------------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".edit-stylist-btn");
  if (!btn) return;

  const payload = {
    id: btn.dataset.id,
    name: btn.dataset.name,
    phone: btn.dataset.phone,
    instagram: btn.dataset.ig,
    specialties: [],
  };

  try {
    payload.specialties = JSON.parse(btn.dataset.specialties || "[]");
  } catch {
    payload.specialties = [];
  }

  window.admin.openEditStylist(payload);
});



// -----------------------------------------
// Inject server variables into window.adminData
// -----------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Extract values from data attributes injected from admin.js
  const root = document.querySelector("#admin-templates-root");
  if (!root) return;

  // The server injects serialized data into the DOM as <div data-???>
  // We reconstruct them here.

  window.adminData = {
    salon_id: root.dataset.salonId || "",
    name: root.dataset.name || "",
    address: root.dataset.address || "",
    city: root.dataset.city || "",
    state: root.dataset.state || "",
    zip: root.dataset.zip || "",
    website: root.dataset.website || "",
    industry: root.dataset.industry || "",
    booking_url: root.dataset.bookingUrl || "",
    timezone: root.dataset.timezone || "",
    tone_profile: root.dataset.tone || "",
    auto_publish: root.dataset.autoPublish == "1",

    posting_start_time: root.dataset.postingStart || "",
    posting_end_time: root.dataset.postingEnd || "",
    spacing_min: parseInt(root.dataset.spacingMin || "20"),
    spacing_max: parseInt(root.dataset.spacingMax || "45"),
    posting_schedule: (() => {
      try { return JSON.parse(root.dataset.postingSchedule || "null"); } catch { return null; }
    })(),

    require_manager_approval: root.dataset.requireManagerApproval == "1",
    auto_approval: root.dataset.autoApproval == "1",
    notify_on_approval: root.dataset.notifyApproval == "1",
    notify_on_denial: root.dataset.notifyDenial == "1",

    salon_tag: root.dataset.salonTag || "",
    custom_hashtags: root.dataset.customHashtags
      ? JSON.parse(root.dataset.customHashtags)
      : []
  };


  console.log("[Admin] adminData:", window.adminData);
  
});

// ---- FIX LEGACY MODAL CLOSE BUTTON ----
const legacyCloseBtn = document.getElementById("admin-modal-close");
if (legacyCloseBtn) {
  legacyCloseBtn.addEventListener("click", () => {
    const modal = document.getElementById("admin-modal");
    const backdrop = document.getElementById("admin-modal-backdrop");
    if (modal) modal.classList.add("hidden");
    if (backdrop) backdrop.classList.add("hidden");
  });
}
