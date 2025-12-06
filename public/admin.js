// public/admin.js
// MostlyPostly Admin — Modal Controller + Template Loader

console.log("[Admin] admin.js loaded");

// Global admin controller namespace
window.admin = {
  templates: {},
  loaded: false,


  // -----------------------------------------
  // Load all HTML templates once on page load
  // -----------------------------------------
  async loadTemplates() {
    if (this.loaded) return;

    const root = document.querySelector("#admin-templates-root");
    if (!root) {
      console.error("Admin template root not found.");
      return;
    }

    const url = root.dataset.url;
    try {
      const html = await fetch(url).then((r) => r.text());

      // Create a hidden container and parse templates
      const div = document.createElement("div");
      div.innerHTML = html;

      const all = div.querySelectorAll("template");
      all.forEach((tpl) => {
        this.templates[tpl.id] = tpl.innerHTML;
      });

      this.loaded = true;
      console.log("[Admin] Templates loaded:", Object.keys(this.templates));
    } catch (err) {
      console.error("Failed to load admin templates:", err);
    }
  },

  // -----------------------------------------
  // Open a modal by template ID
  // -----------------------------------------
  async openModal(templateId) {
    await this.loadTemplates();
    const html = this.templates[templateId];
    if (!html) {
      console.error("Template not found:", templateId);
      return;
    }

    const modal = document.querySelector("#admin-modal");
    const backdrop = document.querySelector("#admin-modal-backdrop");
    const panel = document.querySelector("#admin-modal-content");

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
      "city",
      "state",
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
  // Posting Rules Modal
  // -----------------------------------------
  async openPostingRules() {
    const panel = await this.openModal("tpl-posting-rules");
    if (!panel) return;

    const data = window.adminData;

    const fields = [
      "salon_id",
      "posting_start_time",
      "posting_end_time",
      "spacing_min",
      "spacing_max",
    ];
    fields.forEach((key) => {
      const el = panel.querySelector(`[data-field='${key}']`);
      if (!el) return;
      el.value = data[key] ?? "";
    });

    // Fill dropdown with human-readable labels
    function populateTimeOptions(selectEl) {
      const times = [
        ["07:00", "7:00 AM"],
        ["08:00", "8:00 AM"],
        ["09:00", "9:00 AM"],
        ["10:00", "10:00 AM"],
        ["11:00", "11:00 AM"],
        ["12:00", "12:00 PM"],
        ["13:00", "1:00 PM"],
        ["14:00", "2:00 PM"],
        ["15:00", "3:00 PM"],
        ["16:00", "4:00 PM"],
        ["17:00", "5:00 PM"],
        ["18:00", "6:00 PM"],
        ["19:00", "7:00 PM"],
        ["20:00", "8:00 PM"],
        ["21:00", "9:00 PM"],
        ["22:00", "10:00 PM"],
      ];

      selectEl.innerHTML = times
        .map(
          ([val, label]) =>
            `<option value="${val}" ${
              val === data.posting_start_time || val === data.posting_end_time
                ? "selected"
                : ""
            }>${label}</option>`
        )
        .join("");
    }

    populateTimeOptions(
      panel.querySelector("[data-field='posting_start_time']")
    );
    populateTimeOptions(panel.querySelector("[data-field='posting_end_time']"));
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

    // Salon tag display
    const tagBox = panel.querySelector("[data-field='salon_tag_display']");
    if (tagBox && data.salon_tag) {
      tagBox.innerHTML = `<span class="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[11px]">${data.salon_tag}</span>`;
    }

    // Hidden field
    const hidden = panel.querySelector("#hashtags-json");
    hidden.value = JSON.stringify(data.custom_hashtags || []);

    // Build editable rows
    const rows = panel.querySelector("#hashtags-rows");
    let tags = data.custom_hashtags ? [...data.custom_hashtags] : [];

    function renderRows() {
      rows.innerHTML = "";
      tags.forEach((tag, idx) => {
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        const input = document.createElement("input");
        input.className =
          "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
        input.value = tag.replace(/^#+/, "");
        input.oninput = () => {
          tags[idx] = input.value;
          syncHidden();
        };

        const add = document.createElement("button");
        add.textContent = "+";
        add.className =
          "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-slate-700";
        add.onclick = () => {
          if (tags.length < 4) {
            tags.push("");
            syncHidden();
            renderRows();
          }
        };

        const remove = document.createElement("button");
        remove.textContent = "×";
        remove.className =
          "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-red-500";
        remove.onclick = () => {
          tags.splice(idx, 1);
          syncHidden();
          renderRows();
        };

        row.appendChild(input);
        row.appendChild(add);
        row.appendChild(remove);
        rows.appendChild(row);
      });

      if (tags.length === 0) {
        tags.push("");
        renderRows();
      }
    }

    function syncHidden() {
      const cleaned = tags
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => "#" + t.replace(/^#+/, ""));
      hidden.value = JSON.stringify(cleaned);
    }

    renderRows();
    syncHidden();

    // Public function for Save button
    window.submitHashtagsForm = () => {
      panel.querySelector("form").submit();
    };
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
          "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
        input.value = val;
        input.oninput = () => {
          specs[idx] = input.value;
          syncHidden();
        };

        const add = document.createElement("button");
        add.textContent = "+";
        add.className =
          "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-slate-700";
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
          "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-red-500";
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
    // Edit Stylist Modal (robust version)
    // -----------------------------------------
    async openEditStylist(payload) {
      // Load the modal using the template system
      const panel = await this.openModal("tpl-edit-stylist");
      if (!panel) return;

      const data = window.adminData || {};

      // ---- Basic fields (name / phone / IG) ----
      const salonIdEl = panel.querySelector("[data-field='salon_id']");
      const idEl = panel.querySelector("[data-field='id']");
      const nameEl = panel.querySelector("[data-field='name']");
      const phoneEl = panel.querySelector("[data-field='phone']");
      const igEl = panel.querySelector("[data-field='instagram_handle']");

      if (salonIdEl) salonIdEl.value = data.salon_id || "";
      if (idEl) idEl.value = payload.id || "";
      if (nameEl) nameEl.value = payload.name || "";
      if (phoneEl) phoneEl.value = payload.phone || "";
      if (igEl) igEl.value = payload.instagram || "";

      // ---- Specialties container & hidden JSON ----
      let rows = panel.querySelector("#edit-specialties-rows");
      let hidden = panel.querySelector("#edit-specialties-json");

      // If the template is missing the container, CREATE it
      if (!rows) {
        rows = document.createElement("div");
        rows.id = "edit-specialties-rows";
        rows.className = "space-y-2 mt-2";

        // Try to attach right under the "Specialties" label
        const label = Array.from(panel.querySelectorAll("label")).find((lbl) =>
          (lbl.textContent || "").toLowerCase().includes("specialties")
        );
        if (label && label.parentElement) {
          label.parentElement.appendChild(rows);
        } else if (panel.querySelector("form")) {
          // Fallback: just add into the form
          panel.querySelector("form").appendChild(rows);
        } else {
          panel.appendChild(rows);
        }
      }

      // If the hidden input is missing, CREATE it
      if (!hidden) {
        hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.id = "edit-specialties-json";
        hidden.name = "specialties_json";

        // Try to place it right after the rows container
        if (rows && rows.parentElement) {
          rows.parentElement.appendChild(hidden);
        } else if (panel.querySelector("form")) {
          panel.querySelector("form").appendChild(hidden);
        } else {
          panel.appendChild(hidden);
        }
      }

      // ---- Build specialties list from payload (like old manager-OLD.js) ----
      let specs = [];

      if (Array.isArray(payload.specialties) && payload.specialties.length) {
        specs = payload.specialties
          .map((t) => (t == null ? "" : String(t).trim()))
          .filter((t) => t.length)
          .slice(0, 5);
      }

      // Ensure at least one row so you always see a textbox
      if (specs.length === 0) {
        specs = [""];
      }

      function syncHidden() {
        const cleaned = specs
          .map((x) => (x == null ? "" : String(x).trim()))
          .filter(Boolean)
          .slice(0, 5);

        hidden.value = JSON.stringify(cleaned);
      }

      function render() {
        rows.innerHTML = "";

        specs.forEach((val, idx) => {
          const row = document.createElement("div");
          row.className = "flex items-center gap-2";

          const input = document.createElement("input");
          input.type = "text";
          input.className =
            "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
          input.value = val || "";
          input.placeholder = "specialty";

          input.addEventListener("input", () => {
            specs[idx] = input.value;
            syncHidden();
          });

          const addBtn = document.createElement("button");
          addBtn.type = "button";
          addBtn.textContent = "+";
          addBtn.className =
            "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-slate-700";
          addBtn.addEventListener("click", () => {
            if (specs.length >= 5) return;
            specs.push("");
            render();
            syncHidden();
          });

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.textContent = "×";
          removeBtn.className =
            "px-2 py-1 rounded bg-slate-800 text-xs hover:bg-red-500";
          removeBtn.addEventListener("click", () => {
            specs.splice(idx, 1);
            if (specs.length === 0) specs.push("");
            render();
            syncHidden();
          });

          row.appendChild(input);
          row.appendChild(addBtn);
          row.appendChild(removeBtn);
          rows.appendChild(row);
        });

        syncHidden();
      }

      render();
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
    city: root.dataset.city || "",
    state: root.dataset.state || "",
    website: root.dataset.website || "",
    booking_url: root.dataset.bookingUrl || "",
    timezone: root.dataset.timezone || "",
    tone_profile: root.dataset.tone || "",
    auto_publish: root.dataset.autoPublish == "1",

    posting_start_time: root.dataset.postingStart || "",
    posting_end_time: root.dataset.postingEnd || "",
    spacing_min: parseInt(root.dataset.spacingMin || "20"),
    spacing_max: parseInt(root.dataset.spacingMax || "45"),

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
