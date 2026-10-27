{
  const PAGE = document.body.dataset.page || "login";
  let supabase = null;
  let currentUser = null;
  let currentProfile = null;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const statusLabels = {
    pending: "Menunggu dikerjakan",
    in_progress: "Dalam proses",
    revision: "Perlu revisi",
    submitted: "Menunggu pemeriksaan",
    approved: "Approved",
    rejected: "Ditolak"
  };

  function toast(message, isError = false) {
    const old = $(".toast");
    if (old) old.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function setMessage(el, message, isError = false) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function statusPill(status) {
    return `<span class="status ${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status || "—")}</span>`;
  }

  function fileNameSafe(name) {
    return String(name || "upload").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(-100);
  }

  function ensureConfigured() {
    if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_PUBLISHABLE_KEY ||
        window.SUPABASE_URL.includes("abjeeuvnnkcrldgibyss") ||
        window.SUPABASE_PUBLISHABLE_KEY.includes("sb_publishable_R6ICoqhEy8rSvFhDs6GDbg_j6QZjScV")) {
      const msg = "Konfigurasi belum diisi. Edit js/supabase-config.js dengan Project URL dan Publishable key Supabase.";
      const target = $("#loginMessage") || $(".main-content");
      if (target) {
        if (target.id === "loginMessage") setMessage(target, msg, true);
        else target.insertAdjacentHTML("afterbegin", `<div class="notice"><strong>Konfigurasi Supabase belum diisi</strong><span>${escapeHtml(msg)}</span></div>`);
      }
      return false;
    }
    supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return true;
  }

  async function getSessionProfile() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!session) return null;
    currentUser = session.user;
    const { data, error: profileError } = await supabase.from("profiles")
      .select("id,full_name,role")
      .eq("id", currentUser.id)
      .single();
    if (profileError) throw new Error("Akun login belum memiliki profil role yang valid di tabel profiles: " + profileError.message);
    currentProfile = data;
    return data;
  }

  async function requireRole(role) {
    if (!ensureConfigured()) return false;
    try {
      const profile = await getSessionProfile();
      if (!profile) {
        location.href = "index.html";
        return false;
      }
      if (role && profile.role !== role) {
        location.href = profile.role === "marketing" ? "marketing.html" : "designer.html";
        return false;
      }
      const name = $("#sidebarName");
      const roleEl = $("#sidebarRole");
      if (name) name.textContent = profile.full_name;
      if (roleEl) roleEl.textContent = profile.role === "marketing" ? "Marketing" : "Desainer";
      $$("[data-logout]").forEach(btn => btn.addEventListener("click", logout));
      return true;
    } catch (err) {
      toast(err.message || "Gagal memeriksa sesi login.", true);
      return false;
    }
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    location.href = "index.html";
  }

  async function loginPage() {
    if (!ensureConfigured()) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      try {
        const profile = await getSessionProfile();
        if (profile) location.href = profile.role === "marketing" ? "marketing.html" : "designer.html";
      } catch (e) { /* tetap tampilkan form login agar error dapat diperbaiki */ }
    }
    $("#loginForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const message = $("#loginMessage");
      const button = $('button[type="submit"]', e.currentTarget);
      button.disabled = true;
      setMessage(message, "Memeriksa akun...");
      try {
        const email = $("#email").value.trim();
        const password = $("#password").value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const profile = await getSessionProfile();
        if (!profile) throw new Error("Profil pengguna tidak ditemukan.");
        location.href = profile.role === "marketing" ? "marketing.html" : "designer.html";
      } catch (err) {
        setMessage(message, err.message || "Login gagal.", true);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function fetchDesigns() {
    const { data, error } = await supabase.from("designs")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function fetchRevisions(designId) {
    const { data, error } = await supabase.from("design_revisions")
      .select("*")
      .eq("design_id", designId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function signedUrl(bucket, path) {
    if (!path) return null;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (error) return null;
    return data?.signedUrl || null;
  }

  async function chooseLeastBusyDesigner() {
    const { data: designers, error } = await supabase.from("profiles")
      .select("id,full_name").eq("role", "designer");
    if (error) throw error;
    if (!designers?.length) throw new Error("Belum ada profil Desainer di tabel profiles.");
    const { data: active, error: activeError } = await supabase.from("designs")
      .select("assigned_designer,status")
      .in("status", ["pending", "in_progress", "revision", "submitted"]);
    if (activeError) throw activeError;
    const counts = new Map(designers.map(d => [d.id, 0]));
    (active || []).forEach(d => {
      if (counts.has(d.assigned_designer)) counts.set(d.assigned_designer, counts.get(d.assigned_designer) + 1);
    });
    return designers.slice().sort((a, b) => counts.get(a.id) - counts.get(b.id))[0];
  }

  async function uploadFile(bucket, path, file) {
    const { error } = await supabase.storage.from(bucket).upload(path, file, {
      cacheControl: "3600", upsert: false, contentType: file.type || "application/octet-stream"
    });
    if (error) throw error;
    return path;
  }

  async function marketingPage() {
    if (!await requireRole("marketing")) return;
    $("#designForm")?.addEventListener("submit", createDesign);
    $("#refreshMarketing")?.addEventListener("click", loadMarketingDesigns);
    await loadMarketingDesigns();
  }

  async function createDesign(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('button[type="submit"]', form);
    const message = $("#designFormMessage");
    button.disabled = true;
    setMessage(message, "Menyimpan brief...");
    const fd = new FormData(form);
    try {
      const designer = await chooseLeastBusyDesigner();
      const payload = {
        design_name: String(fd.get("design_name") || "").trim(),
        customer_name: String(fd.get("customer_name") || "").trim() || null,
        sport_type: String(fd.get("sport_type") || "").trim() || null,
        jersey_type: String(fd.get("jersey_type") || "").trim() || null,
        description: String(fd.get("description") || "").trim(),
        created_by: currentUser.id,
        assigned_designer: designer.id,
        status: "pending"
      };
      if (!payload.design_name || !payload.description) throw new Error("Nama desain dan detail brief wajib diisi.");
      const { data: design, error } = await supabase.from("designs").insert(payload).select("*").single();
      if (error) throw error;
      const file = fd.get("reference_file");
      if (file && file.size) {
        const path = `${design.id}/${Date.now()}-${fileNameSafe(file.name)}`;
        try {
          await uploadFile("design-references", path, file);
          const { error: updateError } = await supabase.from("designs")
            .update({ reference_path: path, updated_at: new Date().toISOString() })
            .eq("id", design.id);
          if (updateError) throw updateError;
        } catch (uploadError) {
          toast("Brief tersimpan, tetapi upload referensi gagal: " + uploadError.message, true);
        }
      }
      form.reset();
      setMessage(message, `Brief tersimpan dan otomatis ditugaskan ke ${designer.full_name}.`);
      await loadMarketingDesigns();
    } catch (err) {
      setMessage(message, err.message || "Gagal menyimpan brief.", true);
    } finally {
      button.disabled = false;
    }
  }

  async function loadMarketingDesigns() {
    const root = $("#marketingDesigns");
    if (!root) return;
    root.innerHTML = '<div class="empty-state">Memuat data desain...</div>';
    try {
      const designs = await fetchDesigns();
      $("#statTotal").textContent = designs.length;
      $("#statProgress").textContent = designs.filter(d => ["pending", "in_progress", "revision"].includes(d.status)).length;
      $("#statReview").textContent = designs.filter(d => d.status === "submitted").length;
      $("#statApproved").textContent = designs.filter(d => d.status === "approved").length;
      if (!designs.length) {
        root.innerHTML = '<div class="empty-state">Belum ada brief. Buat permintaan desain pada formulir di atas.</div>';
        return;
      }
      const { data: profiles } = await supabase.from("profiles").select("id,full_name");
      const names = new Map((profiles || []).map(p => [p.id, p.full_name]));
      root.innerHTML = "";
      for (const d of designs) {
        const revisions = await fetchRevisions(d.id);
        const refUrl = await signedUrl("design-references", d.reference_path);
        const latestResult = revisions.find(r => r.result_path);
        const latestUrl = latestResult ? await signedUrl("design-results", latestResult.result_path) : null;
        const card = document.createElement("article");
        card.className = "design-card";
        const revisionHtml = revisions.length ? revisions.map(r => `
          <div class="revision-row">
            <p><b>Revisi #${escapeHtml(r.revision_number)}</b><small>${escapeHtml(r.revision_note || "Tanpa catatan")} · ${new Date(r.created_at).toLocaleString("id-ID")}</small>
            ${r.result_path ? `<small>File hasil tersedia ${latestResult?.id === r.id ? " (terbaru)" : ""}</small>` : `<small>Menunggu upload hasil</small>`}</p>
            ${r.result_path ? `<button class="btn btn-small btn-success" data-approve="${escapeHtml(r.id)}" data-design="${escapeHtml(d.id)}">Approve hasil ini</button>` : ""}
          </div>`).join("") : '<p class="muted">Belum ada riwayat revisi atau hasil upload.</p>';
        card.innerHTML = `
          <div>
            <div class="design-meta">${statusPill(d.status)}<span>${escapeHtml(d.sport_type || "Olahraga belum diisi")}</span><span>${escapeHtml(d.jersey_type || "Jenis belum diisi")}</span></div>
            <h3>${escapeHtml(d.design_name)}</h3>
            <div class="design-meta"><span>Pelanggan: ${escapeHtml(d.customer_name || "—")}</span><span>Desainer: ${escapeHtml(names.get(d.assigned_designer) || "Belum ditugaskan")}</span><span>Dibuat: ${new Date(d.created_at).toLocaleDateString("id-ID")}</span></div>
            <p class="design-description">${escapeHtml(d.description)}</p>
            ${refUrl ? `<p><a class="file-link" href="${refUrl}" target="_blank" rel="noopener">Buka gambar referensi ↗</a></p>` : ""}
            ${latestUrl ? `<p><a class="file-link" href="${latestUrl}" target="_blank" rel="noopener">Lihat hasil upload terbaru ↗</a></p>` : ""}
            <div class="revision-box"><h4>RIWAYAT HASIL & REVISI</h4>${revisionHtml}</div>
            <form class="inline-form" data-revision-form="${escapeHtml(d.id)}">
              <label>Catatan revisi untuk Desainer<textarea name="revision_note" placeholder="Jelaskan bagian yang perlu diperbaiki..." required></textarea></label>
              <div class="card-actions"><button class="btn btn-small btn-quiet" type="submit">Minta revisi</button><button class="btn btn-small btn-danger" type="button" data-delete="${escapeHtml(d.id)}">Hapus desain</button></div>
            </form>
          </div>
          <div class="card-actions">
            <label class="status-select-label">Status
              <select data-status="${escapeHtml(d.id)}" aria-label="Ubah status">
                ${Object.entries(statusLabels).map(([value,label]) => `<option value="${value}" ${d.status === value ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </label>
          </div>`;
        root.appendChild(card);
      }
      $$("[data-status]", root).forEach(el => el.addEventListener("change", () => updateStatus(el.dataset.status, el.value)));
      $$("[data-delete]", root).forEach(el => el.addEventListener("click", () => deleteDesign(el.dataset.delete)));
      $$("[data-revision-form]", root).forEach(el => el.addEventListener("submit", e => requestRevision(e, el.dataset.revisionForm)));
      $$("[data-approve]", root).forEach(el => el.addEventListener("click", () => approveRevision(el.dataset.design, el.dataset.approve)));
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Gagal memuat desain: ${escapeHtml(err.message || "Kesalahan tidak diketahui")}</div>`;
    }
  }

  async function updateStatus(id, status) {
    try {
      const patch = { status, updated_at: new Date().toISOString() };
      if (status !== "approved") {
        patch.approved_by = null;
        patch.approved_at = null;
      }
      const { error } = await supabase.from("designs").update(patch).eq("id", id);
      if (error) throw error;
      toast("Status desain diperbarui.");
      await loadMarketingDesigns();
    } catch (err) { toast("Gagal memperbarui status: " + err.message, true); }
  }

  async function requestRevision(e, designId) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get("revision_note") || "").trim();
    if (!note) return;
    try {
      const existing = await fetchRevisions(designId);
      const nextNumber = existing.reduce((m, r) => Math.max(m, Number(r.revision_number) || 0), 0) + 1;
      const { error: revError } = await supabase.from("design_revisions").insert({
        design_id: designId,
        revision_number: nextNumber,
        revision_note: note,
        requested_by: currentUser.id
      });
      if (revError) throw revError;
      const { error: updateError } = await supabase.from("designs")
        .update({ status: "revision", revision_note: note, updated_at: new Date().toISOString() })
        .eq("id", designId);
      if (updateError) throw updateError;
      toast("Permintaan revisi tersimpan.");
      await loadMarketingDesigns();
    } catch (err) { toast("Gagal meminta revisi: " + err.message, true); }
  }

  async function approveRevision(designId, revisionId) {
    if (!confirm("Setujui hasil ini? Desain akan tampil di Gallery approved.")) return;
    try {
      const { data: revision, error: revisionError } = await supabase.from("design_revisions")
        .select("id,result_path").eq("id", revisionId).eq("design_id", designId).single();
      if (revisionError) throw revisionError;
      if (!revision.result_path) throw new Error("Riwayat ini belum memiliki file hasil.");
      const { error } = await supabase.from("designs").update({
        result_path: revision.result_path,
        status: "approved",
        approved_by: currentUser.id,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", designId);
      if (error) throw error;
      toast("Desain disetujui dan masuk Gallery.");
      await loadMarketingDesigns();
    } catch (err) { toast("Gagal menyetujui desain: " + err.message, true); }
  }

  async function deleteDesign(id) {
    if (!confirm("Hapus desain ini beserta riwayat revisinya? Tindakan ini tidak dapat dibatalkan.")) return;
    try {
      const { error } = await supabase.from("designs").delete().eq("id", id);
      if (error) throw error;
      toast("Desain dihapus dari database.");
      await loadMarketingDesigns();
    } catch (err) { toast("Gagal menghapus desain: " + err.message, true); }
  }

  async function designerPage() {
    if (!await requireRole("designer")) return;
    $("#refreshDesigner")?.addEventListener("click", loadDesignerTasks);
    await loadDesignerTasks();
  }

  async function loadDesignerTasks() {
    const root = $("#designerTasks");
    if (!root) return;
    root.innerHTML = '<div class="empty-state">Memuat tugas...</div>';
    try {
      const designs = await fetchDesigns();
      if (!designs.length) {
        root.innerHTML = '<div class="empty-state">Belum ada tugas yang ditugaskan kepada Anda.</div>';
        return;
      }
      root.innerHTML = "";
      for (const d of designs) {
        const revisions = await fetchRevisions(d.id);
        const refUrl = await signedUrl("design-references", d.reference_path);
        const card = document.createElement("article");
        card.className = "design-card";
        card.innerHTML = `
          <div>
            <div class="design-meta">${statusPill(d.status)}<span>${escapeHtml(d.sport_type || "Olahraga")}</span><span>${escapeHtml(d.jersey_type || "Jenis apparel")}</span></div>
            <h3>${escapeHtml(d.design_name)}</h3>
            <div class="design-meta"><span>Pelanggan: ${escapeHtml(d.customer_name || "—")}</span><span>Diterima: ${new Date(d.created_at).toLocaleDateString("id-ID")}</span></div>
            <p class="design-description">${escapeHtml(d.description)}</p>
            ${refUrl ? `<p><a class="file-link" href="${refUrl}" target="_blank" rel="noopener">Buka gambar referensi ↗</a></p>` : ""}
            ${d.revision_note && d.status === "revision" ? `<div class="notice"><strong>Catatan revisi</strong><span>${escapeHtml(d.revision_note)}</span></div>` : ""}
            <div class="revision-box"><h4>RIWAYAT UPLOAD</h4>
              ${revisions.length ? revisions.map(r => `<div class="revision-row"><p><b>Versi #${escapeHtml(r.revision_number)}</b><small>${escapeHtml(r.revision_note || "Hasil desain")} · ${new Date(r.created_at).toLocaleString("id-ID")}</small></p>${r.result_path ? `<span class="status submitted">File diunggah</span>` : `<span class="status revision">Permintaan revisi</span>`}</div>`).join("") : '<p class="muted">Belum ada upload.</p>'}
            </div>
            <form class="inline-form" data-upload-form="${escapeHtml(d.id)}">
              <label>Catatan untuk Marketing (opsional)<textarea name="upload_note" placeholder="Contoh: versi awal / revisi motif bagian lengan"></textarea></label>
              <label>File hasil desain *<input name="result_file" type="file" accept="image/*,.pdf" required></label>
              <button class="btn btn-primary" type="submit">Upload hasil desain ↗</button>
            </form>
          </div>
          <div class="card-actions">${statusPill(d.status)}</div>`;
        root.appendChild(card);
      }
      $$("[data-upload-form]", root).forEach(el => el.addEventListener("submit", e => uploadDesignResult(e, el.dataset.uploadForm)));
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Gagal memuat tugas: ${escapeHtml(err.message || "Kesalahan tidak diketahui")}</div>`;
    }
  }

  async function uploadDesignResult(e, designId) {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const fd = new FormData(form);
      const file = fd.get("result_file");
      const note = String(fd.get("upload_note") || "").trim() || "Upload hasil desain";
      if (!file || !file.size) throw new Error("Pilih file hasil desain terlebih dahulu.");
      const { data: design, error: designError } = await supabase.from("designs")
        .select("id,created_by,assigned_designer").eq("id", designId).single();
      if (designError) throw designError;
      if (design.assigned_designer !== currentUser.id) throw new Error("Desain ini bukan tugas yang ditugaskan kepada akun Anda.");
      const revisions = await fetchRevisions(designId);
      const nextNumber = revisions.reduce((m, r) => Math.max(m, Number(r.revision_number) || 0), 0) + 1;
      const path = `${designId}/${Date.now()}-${fileNameSafe(file.name)}`;
      await uploadFile("design-results", path, file);
      const { error } = await supabase.from("design_revisions").insert({
        design_id: designId,
        revision_number: nextNumber,
        revision_note: note,
        requested_by: design.created_by,
        result_path: path,
        uploaded_by: currentUser.id
      });
      if (error) throw error;
      toast("Hasil berhasil diunggah. Marketing dapat memeriksa hasil tersebut.");
      await loadDesignerTasks();
    } catch (err) {
      toast("Upload gagal: " + (err.message || "Kesalahan tidak diketahui"), true);
    } finally {
      button.disabled = false;
    }
  }

  async function galleryPage() {
    if (!ensureConfigured()) return;
    const root = $("#galleryGrid");
    try {
      const { data, error } = await supabase.from("designs")
        .select("id,design_name,customer_name,sport_type,jersey_type,description,result_path,approved_at,status")
        .eq("status", "approved")
        .order("approved_at", { ascending: false });
      if (error) throw error;
      const designs = data || [];
      $("#galleryCount").textContent = designs.length;
      if (!designs.length) {
        root.innerHTML = '<div class="empty-state">Belum ada desain yang disetujui Marketing.</div>';
        return;
      }
      root.innerHTML = "";
      for (const d of designs) {
        const url = await signedUrl("design-results", d.result_path);
        const card = document.createElement("article");
        card.className = "gallery-card";
        card.innerHTML = `
          ${url ? `<a href="${url}" target="_blank" rel="noopener"><img class="gallery-image" src="${url}" alt="${escapeHtml(d.design_name)}"></a>` : '<div class="gallery-placeholder">Preview tidak tersedia</div>'}
          <div class="gallery-body"><span class="status approved">APPROVED</span><h3>${escapeHtml(d.design_name)}</h3><p>${escapeHtml(d.customer_name || "")}${d.sport_type ? " · " + escapeHtml(d.sport_type) : ""}${d.jersey_type ? " · " + escapeHtml(d.jersey_type) : ""}</p><p style="margin-top:9px">${escapeHtml(d.description || "")}</p></div>`;
        root.appendChild(card);
      }
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Gallery gagal dimuat: ${escapeHtml(err.message || "Kesalahan tidak diketahui")}</div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (PAGE === "login") loginPage();
    else if (PAGE === "marketing") marketingPage();
    else if (PAGE === "designer") designerPage();
    else if (PAGE === "gallery") galleryPage();
  });
})();
