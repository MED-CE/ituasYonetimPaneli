import { useEffect, useMemo, useState, useRef } from "react";
import { supabase } from "./lib/supabase";
import OneSignal from 'react-onesignal';

const STORAGE_KEY = "ituasotonom_v1";
const WORKSHOP_QR_TOKEN = "ITUAS-OTONOM-WORKSHOP-V1";

function durationText(milliseconds = 0) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} sa ${minutes % 60} dk` : `${minutes} dk`;
}

function sessionDuration(session, now = new Date()) {
  return Math.max(0, new Date(session.check_out || now).getTime() - new Date(session.check_in).getTime());
}

function workshopTotals(sessions = [], now = new Date()) {
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const totalSince = (start) => sessions.reduce((sum, session) => {
    const end = new Date(session.check_out || now);
    const begin = new Date(session.check_in);
    if (end <= start) return sum;
    return sum + Math.max(0, end - (begin > start ? begin : start));
  }, 0);
  return { today: totalSince(startOfDay), week: totalSince(startOfWeek), month: totalSince(startOfMonth), total: totalSince(new Date(0)) };
}

function whatsappBaseUrls() {
  return [...new Set([
    "http://127.0.0.1:3001",
    import.meta.env.DEV ? "/whatsapp-api" : null,
    import.meta.env.VITE_WHATSAPP_API_URL || null,
  ].filter(Boolean))].map(url => String(url).replace(/\/$/, ""));
}

async function fetchWhatsApp(path, options) {
  let lastError = new Error("WhatsApp API'ye ulaşılamadı");
  for (const base of whatsappBaseUrls()) {
    try {
      const response = await fetch(`${base}${path}`, options);
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function sendWhatsAppTaskNotification(payload) {
  try {
    const response = await fetchWhatsApp("/task-assigned", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `WhatsApp API ${response.status}`);
    return body;
  } catch (error) {
    console.error("WhatsApp görev bildirimi gönderilemedi:", error);
    return { ok: false, error: error.message };
  }
}

export async function sendPushNotification(title, message) {
  const appId = import.meta.env.VITE_ONESIGNAL_APP_ID;
  const apiKey = import.meta.env.VITE_ONESIGNAL_API_KEY;
  if (!appId || !apiKey) return false;

  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${apiKey}`
      },
      body: JSON.stringify({
        app_id: appId,
        included_segments: ["Total Subscriptions"],
        headings: { en: title, tr: title },
        contents: { en: message, tr: message }
      })
    });
    return response.ok;
  } catch (error) {
    console.error("OneSignal push bildirimi gönderilemedi:", error);
    return false;
  }
}

let approvalsBackoffUntil = 0;

async function applyWhatsAppApprovals() {
  if (Date.now() < approvalsBackoffUntil) return;
  try {
    const response = await fetchWhatsApp("/approvals");
    if (!response.ok) {
      approvalsBackoffUntil = Date.now() + 15000;
      return;
    }
    approvalsBackoffUntil = 0;
    const body = await response.json().catch(() => ({}));
    const decisions = Array.isArray(body.decisions) ? body.decisions : [];
    if (!decisions.length) return;

    const applied = [];
    for (const decision of decisions) {
      if (!decision.taskId || !decision.status) continue;
      const { data: row, error } = await supabase
        .from("tasks")
        .select("id,status")
        .eq("id", decision.taskId)
        .maybeSingle();
      if (error) continue;
      if (row && row.status !== decision.status) {
        const { error: updateError } = await supabase
          .from("tasks")
          .update({ status: decision.status })
          .eq("id", decision.taskId);
        if (updateError) continue;
      }
      applied.push(decision.taskId);
    }

    if (applied.length) {
      await fetchWhatsApp("/approvals/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: applied }),
      });
    }
  } catch {
    approvalsBackoffUntil = Date.now() + 15000;
  }
}

const initialData = {
  user: null,
  members: [
    { id: 1, name: "Ali Eren", role: "Yönetici", department: "Yönetim", email: "ali@ituasotonom.com", phone: "", active: true },
    { id: 2, name: "Mehmet", role: "Kaptan", department: "Mechanical", email: "", phone: "", active: true },
    { id: 3, name: "Yahya", role: "Kaptan", department: "Programming", email: "", phone: "", active: true },
    { id: 4, name: "Miraç", role: "Üye", department: "Electronics", email: "", phone: "", active: true },
  ],
  events: [
    { id: 1, date: "2026-08-15", title: "Sezon Toplantısı", start: "18:00", end: "20:00", location: "Atölye", type: "Toplantı", description: "Yeni sezon görev dağılımı.", creator: "Yönetici" },
    { id: 2, date: "2026-08-17", title: "Robot Çalışması", start: "18:00", end: "21:00", location: "Robot Atölyesi", type: "Robot Çalışması", description: "Şasi ve mekanizma çalışması.", creator: "Kaptan" },
    { id: 3, date: "2026-08-20", title: "Müsabaka Hazırlığı", start: "17:00", end: "19:00", location: "Atölye", type: "Müsabaka", description: "Test ve sürüş hazırlığı.", creator: "Kaptan" },
  ],
  announcements: [
    { id: 1, title: "Müsabaka hazırlıkları başlıyor!", body: "Yeni sezon için hazırlıklarımız başladı. Tüm ekip üyelerinin katılımını bekliyoruz.", date: "2026-08-10T17:00:00", priority: "Yüksek", author: "Yönetici", pinned: true },
    { id: 2, title: "Atölye kullanım kuralları", body: "Atölyemizde güvenli ve verimli çalışma için kurallara dikkat edelim.", date: "2026-08-09T13:00:00", priority: "Normal", author: "Kaptan", pinned: false },
  ],
  tasks: [
    { id: 1, title: "Robot kolunun montajı", description: "Montajı tamamla ve test videosunu ekibe gönder.", assignee: "Mehmet", due: "2026-08-15", priority: "Yüksek", status: "Devam Ediyor" },
    { id: 2, title: "Otonom kod testi", description: "Otonom rutinleri saha üzerinde test et.", assignee: "Yahya", due: "2026-08-17", priority: "Orta", status: "Devam Ediyor" },
    { id: 3, title: "Elektronik stok kontrolü", description: "Eksik parçaları listele.", assignee: "Miraç", due: "2026-08-12", priority: "Düşük", status: "Bekliyor" },
  ],
  settings: {
    teamName: "İTÜAS Otonom Tekne Takımı",
    systemName: "Team Management System",
    motto: "Birlikte Çalış, Birlikte Başar!",
    announcementsEnabled: true,
  },
};

const menu = [
  ["⌂", "Ana Sayfa"],
  ["▣", "Takvim"],
  ["◈", "Duyurular"],
  ["✓", "Görevler"],
  ["♧", "Üyeler"],
  ["▥", "Raporlar"],
];

const roles = ["Yönetici", "Kaptan", "Yazılım Kaptanı", "Elektronik Kaptanı", "Organizasyon Kaptanı", "Mekanik Kaptanı", "Üye"];
const departments = ["Yönetim", "Mekanik", "Yazılım", "Elektronik", "Organizasyon", "Diğer"];

function getManagedDepartments(role) {
  if (role === "Yönetici" || role === "Kaptan") return "ALL";
  if (role === "Yazılım Kaptanı") return ["Yazılım"];
  if (role === "Elektronik Kaptanı") return ["Elektronik"];
  if (role === "Organizasyon Kaptanı") return ["Organizasyon"];
  if (role === "Mekanik Kaptanı") return ["Mekanik"];
  return [];
}

function loadData() {
  return initialData;
}

function mapProfile(row) {
  return {
    id: row.id,
    name: row.full_name || row.username || "Yeni Üye",
    role: row.role || "Üye",
    department: row.department || "Other",
    email: row.email || "",
    phone: row.phone || "",
    active: row.active !== false,
    username: row.username || "",
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    date: row.event_date || row.date || "",
    title: row.title || "",
    start: row.start_time || row.start || "",
    end: row.end_time || row.end || "",
    location: row.location || "",
    type: row.event_type || row.type || "Etkinlik",
    description: row.description || "",
    creator: row.creator || row.creator_name || "",
    created_by: row.created_by || null,
    target_departments: row.target_departments || ["ALL"],
  };
}

function mapAnnouncement(row) {
  return {
    id: row.id,
    title: row.title || "",
    body: row.body || "",
    date: row.created_at || row.date || new Date().toISOString(),
    priority: row.priority || "Normal",
    author: row.author || row.author_name || "Yönetici",
    author_id: row.author_id || null,
    pinned: !!row.pinned,
  };
}

function mapTask(row, members) {
  const member = (members || []).find(m => String(m.id) === String(row.assigned_id));
  const assignedId = row.assigned_id ?? row.assigneeId ?? row.assignedTo ?? member?.id ?? null;
  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    assignee: row.assignee || member?.name || "",
    assigned_id: assignedId,
    assignedId,
    assigneeId: assignedId,
    due: row.due_date || row.due || "",
    priority: row.priority || "Orta",
    status: row.status || "Bekliyor",
  };
}

function mapWorkshopSession(row) {
  return { id: row.id, member_id: row.member_id, check_in: row.check_in, check_out: row.check_out, created_at: row.created_at };
}

function mapEventAttendance(row) {
  const plannedStatus = row.planned_status || row.plannedStatus || "cevap_vermedi";
  const actualStatus = row.actual_status || row.actualStatus || null;
  const eventId = row.event_id ?? row.eventId;
  const memberId = row.member_id ?? row.memberId;

  // Hem veritabanı (snake_case) hem de arayüz (camelCase)
  // aynı kaydı kullanabilsin. Böylece Takvim -> Profil senkronu
  // anında doğru çalışır.
  return {
    id: row.id,
    event_id: eventId,
    member_id: memberId,
    planned_status: plannedStatus,
    actual_status: actualStatus,
    updated_at: row.updated_at || row.created_at || null,

    // Profil ekranının kullandığı kolay erişim alanları
    eventId,
    memberId,
    plannedStatus,
    actualStatus,
  };
}

function eventToDb(item) {
  return {
    id: item.id,
    title: item.title,
    event_date: item.date,
    start_time: item.start || null,
    end_time: item.end || null,
    location: item.location || "",
    event_type: item.type || "Etkinlik",
    description: item.description || "",
    created_by: item.created_by || null,
    target_departments: item.target_departments || ["ALL"],
  };
}

function announcementToDb(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body || "",
    priority: item.priority || "Normal",
    pinned: !!item.pinned,
    author_id: item.author_id || null,
    created_at: item.date || new Date().toISOString(),
  };
}

function taskToDb(item, members) {
  const member =
    (members || []).find(m => String(m.id) === String(item.assigned_id)) ||
    (members || []).find(m => String(m.name) === String(item.assignee));
  const row = {
    title: item.title,
    description: item.description || "",
    assigned_id: item.assigned_id || member?.id || null,
    due_date: item.due || null,
    priority: item.priority || "Orta",
    status: item.status || "Bekliyor",
    created_by: item.created_by || null,
  };
  if (item.id != null && item.id !== "") row.id = item.id;
  return row;
}

async function insertTaskRow(payload) {
  let current = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row, error } = await supabase.from("tasks").insert(current).select("*").single();
    if (!error) return { row, error: null };

    const msg = String(error.message || "");
    const missing =
      msg.match(/Could not find the ['"]([^'"]+)['"] column/i) ||
      msg.match(/column ["']([^"']+)["'] of relation/i);
    const missingCol = missing?.[1];
    if (error.code === "PGRST204" && missingCol && missingCol in current) {
      delete current[missingCol];
      continue;
    }
    if (error.code === "PGRST204" && /assigned_id/.test(msg) && "assigned_id" in current) {
      delete current.assigned_id;
      continue;
    }
    if (error.code === "PGRST204" && /assignee/.test(msg) && "assignee" in current) {
      delete current.assignee;
      continue;
    }
    if (/null value in column ["']id["']/i.test(msg) && !current.id) {
      current.id = crypto.randomUUID();
      continue;
    }
    return { row: null, error };
  }
  return { row: null, error: { message: "Görev kaydı denemeleri tükendi" } };
}

function profileToDb(item) {
  return {
    id: item.id,
    username: item.username || null,
    full_name: item.name || "",
    role: item.role || "Üye",
    department: item.department || "Diğer",
    email: item.email || null,
    phone: item.phone || null,
    active: item.active !== false,
  };
}

function settingsToDb(settings) {
  return {
    id: 1,
    team_name: settings.teamName,
    system_name: settings.systemName,
    motto: settings.motto,
    announcements_enabled: settings.announcementsEnabled !== false,
  };
}

function mapSettings(row) {
  if (!row) return null;
  return {
    teamName: row.team_name ?? row.teamName ?? initialData.settings.teamName,
    systemName: row.system_name ?? row.systemName ?? initialData.settings.systemName,
    motto: row.motto ?? initialData.settings.motto,
    announcementsEnabled: row.announcements_enabled ?? row.announcementsEnabled ?? true,
  };
}

async function fetchCloudData() {
  const result = {
    members: initialData.members,
    events: initialData.events,
    announcements: initialData.announcements,
    tasks: initialData.tasks,
    settings: initialData.settings,
    workshopSessions: [],
    eventAttendance: [],
  };

  const [profilesRes, eventsRes, announcementsRes, tasksRes, settingsRes, workshopRes, attendanceRes] = await Promise.all([
    supabase.from("profiles").select("*"),
    supabase.from("events").select("*").order("event_date", { ascending: true }),
    supabase.from("announcements").select("*").order("created_at", { ascending: false }),
    supabase.from("tasks").select("*").order("due_date", { ascending: true }),
    supabase.from("team_settings").select("*").limit(1),
    supabase.from("workshop_sessions").select("*").order("check_in", { ascending: false }),
    supabase.from("event_attendance").select("*").order("updated_at", { ascending: false }),
  ]);

  if (!profilesRes.error && profilesRes.data?.length) result.members = profilesRes.data.map(mapProfile);
  else if (profilesRes.error) console.error("profiles okunamadı:", profilesRes.error);

  if (!eventsRes.error) result.events = (eventsRes.data || []).map(mapEvent);
  else console.error("events okunamadı:", eventsRes.error);

  if (!announcementsRes.error) result.announcements = (announcementsRes.data || []).map(mapAnnouncement);
  else console.error("announcements okunamadı:", announcementsRes.error);

  if (!tasksRes.error) result.tasks = (tasksRes.data || []).map(row => mapTask(row, result.members));
  else console.error("tasks okunamadı:", tasksRes.error);

  if (!settingsRes.error && settingsRes.data?.[0]) {
    result.settings = { ...initialData.settings, ...mapSettings(settingsRes.data[0]) };
  } else if (settingsRes.error) {
    console.error("team_settings okunamadı:", settingsRes.error);
  }

  if (!workshopRes.error) result.workshopSessions = (workshopRes.data || []).map(mapWorkshopSession);
  else if (workshopRes.error && workshopRes.error.code !== "42P01") console.error("workshop_sessions okunamadı:", workshopRes.error);

  if (!attendanceRes.error) result.eventAttendance = (attendanceRes.data || []).map(mapEventAttendance);
  else if (attendanceRes.error && attendanceRes.error.code !== "42P01") console.error("event_attendance okunamadı:", attendanceRes.error);

  return result;
}

async function syncCollection(table, before, after, toDb) {
  const beforeMap = new Map((before || []).map(item => [String(item.id), item]));
  const afterMap = new Map((after || []).map(item => [String(item.id), item]));

  const changed = [];
  for (const item of after || []) {
    const old = beforeMap.get(String(item.id));
    if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
      changed.push(toDb(item));
    }
  }

  if (changed.length) {
    // profiles mevcut Auth kullanıcılarının satırlarıdır.
    // Yeni profil oluşturmak için INSERT yetkisi vermiyoruz; mevcut
    // profili doğrudan UPDATE ediyoruz. Böylece rol/bölüm değişiklikleri
    // RLS tarafından doğru şekilde kontrol edilir.
    if (table === "profiles") {
      for (const row of changed) {
        const { id, ...profile } = row;
        const { error } = await supabase
          .from("profiles")
          .update(profile)
          .eq("id", id);
        if (error) throw error;
      }
    } else if (table === "tasks") {
      for (const row of changed) {
        const { id, ...payload } = row;
        let error;
        if (id) {
          const res = await supabase.from("tasks").update(payload).eq("id", id);
          error = res.error;
        } else {
          const res = await supabase.from("tasks").insert(payload);
          error = res.error;
        }
        if (error) throw error;
      }
    } else {
      let { error } = await supabase.from(table).upsert(changed);

      if (error) throw error;
    }
  }

  const removed = [...beforeMap.keys()].filter(id => !afterMap.has(id));
  if (removed.length) {
    const { error } = await supabase.from(table).delete().in("id", removed);
    if (error) throw error;
  }
}

async function syncCloudPatch(before, after, patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "events")) {
    await syncCollection("events", before.events, after.events, eventToDb);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "announcements")) {
    await syncCollection("announcements", before.announcements, after.announcements, announcementToDb);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "tasks")) {
    await syncCollection("tasks", before.tasks, after.tasks, item => taskToDb(item, after.members));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "members")) {
    await syncCollection("profiles", before.members, after.members, profileToDb);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "settings")) {
    const { error } = await supabase.from("team_settings").upsert(settingsToDb(after.settings));
    if (error) throw error;
  }
}

function Login({ onLogin }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  useEffect(() => {
    const checkRecovery = () => {
      if (window.location.hash.includes("type=recovery")) {
        setResetMode(true);
      }
    };

    checkRecovery();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setResetMode(true);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const result = await onLogin(identifier.trim(), password);

      if (!result?.success) {
        setError(result?.message || "Giriş yapılamadı.");
      }
    } catch (err) {
      console.error(err);
      setError("Giriş sırasında bir hata oluştu.");
    } finally {
      setLoading(false);
    }
  }

  async function sendResetEmail() {
    setError("");
    setMessage("");

    if (!identifier.trim()) {
      setError("Önce e-posta adresini yaz.");
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        identifier.trim(),
        {
          redirectTo: window.location.origin,
        }
      );

      if (error) {
        throw error;
      }

      setMessage(
        "Şifre sıfırlama bağlantısı e-posta adresine gönderildi."
      );
    } catch (err) {
      console.error(err);
      setError(
        err?.message || "Şifre sıfırlama bağlantısı gönderilemedi."
      );
    } finally {
      setLoading(false);
    }
  }

  async function updatePassword() {
    setError("");
    setMessage("");

    if (newPassword.length < 6) {
      setError("Yeni şifre en az 6 karakter olmalı.");
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        throw error;
      }

      setMessage("Şifren başarıyla değiştirildi.");

      setNewPassword("");
      setResetMode(false);

      window.history.replaceState(
        {},
        document.title,
        window.location.pathname
      );
    } catch (err) {
      console.error(err);
      setError(
        err?.message || "Şifre değiştirilemedi."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="loginPage">
      <form
        className="loginBox"
        onSubmit={resetMode ? (e) => e.preventDefault() : submit}
      >
        <img
          src="/ituas-logo.jpg"
          className="loginLogo"
          alt="İTÜAS Otonom Tekne Takımı"
        />

        <div className="eyebrow">İTÜAS OTONOM</div>

        <h1>İTÜAS</h1>

        <p>Takım Yönetim Sistemi</p>

        {!resetMode ? (
          <>
            <label>
              Kullanıcı Adı / E-posta

              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Yerel test için 'dev' yazın"
                autoComplete="username"
              />
            </label>

            <label>
              Şifre

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Şifren"
                autoComplete="current-password"
              />
            </label>

            {error && (
              <div className="error">
                {error}
              </div>
            )}

            {message && (
              <div className="success">
                {message}
              </div>
            )}

            <button
              className="primary loginButton"
              disabled={loading}
            >
              {loading ? "Giriş yapılıyor..." : "Giriş Yap"}
            </button>

              <small className="loginHint">
                Yerel test için e-posta kısmına "dev" yazıp rastgele bir şifreyle girebilirsiniz.
              </small>
          </>
        ) : (
          <>
            <h2>Yeni Şifre Belirle</h2>

            <p>
              Hesabın için yeni şifreni aşağıdan belirleyebilirsin.
            </p>

            <label>
              Yeni Şifre

              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Yeni şifren"
                autoComplete="new-password"
              />
            </label>

            {error && (
              <div className="error">
                {error}
              </div>
            )}

            {message && (
              <div className="success">
                {message}
              </div>
            )}

            <button
              type="button"
              className="primary loginButton"
              onClick={updatePassword}
              disabled={loading}
            >
              {loading
                ? "Şifre değiştiriliyor..."
                : "Yeni Şifreyi Kaydet"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}


function App() {
  const [data, setData] = useState(loadData);
  const [page, setPage] = useState("Ana Sayfa");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const searchBoxRef = useRef(null);
  const cloudLoaded = useRef(false);
  const realtimeStarted = useRef(false);
  const syncing = useRef(false);

  // Cloud verisi kullanıcı doğrulandıktan sonra yüklenir.
  // Böylece ilk açılışta anon rolüyle yapılan 401/403 sorguları olmaz.


  // OneSignal Push Bildirimlerini Başlat
  useEffect(() => {
    const appId = import.meta.env.VITE_ONESIGNAL_APP_ID;
    if (appId) {
      OneSignal.init({
        appId: appId,
        allowLocalhostAsSecureOrigin: true,
        notifyButton: {
          enable: true,
          colors: { "circle.background": "#00b4d8" }
        }
      }).then(() => {
        OneSignal.Slidedown.promptPush();
      });
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  const currentUser = data.user;
  const role = currentUser?.role || "";

  const update = async (patch) => {
    const before = data;
    const after = { ...data, ...patch };

    setData(after);

    try {
      syncing.current = true;
      await syncCloudPatch(before, after, patch);
    } catch (err) {
      console.error("Buluta kaydedilemedi:", err);
      flash("Buluta kaydedilemedi. RLS / tablo izinlerini kontrol et.");
      setData(before);
    } finally {
      syncing.current = false;
    }
  };

  const flash = (text) => setNotice(text);

  const quickResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("tr-TR");
    if (!query) return [];

    const results = [];
    const pages = [
      ["Ana Sayfa", "⌂", "Takım genel görünümü"],
      ["Takvim", "▣", "Etkinlikler ve katılım"],
      ["Duyurular", "◈", "Takım duyuruları"],
      ["Görevler", "✓", "Görevler ve durumları"],
      ["Profilim", "◎", "Kişisel bilgiler ve aktiviteler"],
      ["Atölyem", "⌁", "Atölye giriş-çıkış ve süreler"],
      ["Üyeler", "♧", "Takım üyeleri"]
    ];

    pages.forEach(([title, icon, sub]) => {
      if (`${title} ${sub}`.toLocaleLowerCase("tr-TR").includes(query)) {
        results.push({ kind: "sayfa", title, sub, icon, page: title });
      }
    });

    data.events.forEach(event => {
      const haystack = `${event.title} ${event.location} ${event.type} ${event.description}`.toLocaleLowerCase("tr-TR");
      if (haystack.includes(query)) results.push({ kind: "etkinlik", title: event.title, sub: `${event.date} · ${event.location || "Konum yok"}`, icon: "▣", page: "Takvim" });
    });

    data.tasks.forEach(task => {
      const haystack = `${task.title} ${task.description || ""} ${task.status || ""}`.toLocaleLowerCase("tr-TR");
      if (haystack.includes(query)) results.push({ kind: "görev", title: task.title, sub: `${task.status || "Görev"}${task.due ? ` · ${task.due}` : ""}`, icon: "✓", page: "Görevler" });
    });

    data.announcements.forEach(item => {
      const haystack = `${item.title} ${item.body || ""}`.toLocaleLowerCase("tr-TR");
      if (haystack.includes(query)) results.push({ kind: "duyuru", title: item.title, sub: "Duyuru", icon: "◈", page: "Duyurular" });
    });

    data.members.forEach(member => {
      const haystack = `${member.name} ${member.username || ""} ${member.department || ""} ${member.role || ""}`.toLocaleLowerCase("tr-TR");
      if (haystack.includes(query)) results.push({ kind: "üye", title: member.name, sub: `${member.role || "Üye"} · ${member.department || "Bölüm yok"}`, icon: "♧", page: "Üyeler" });
    });

    return results.slice(0, 10);
  }, [search, data.events, data.tasks, data.announcements, data.members]);

  useEffect(() => {
    const closeSearch = (event) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", closeSearch);
    return () => document.removeEventListener("mousedown", closeSearch);
  }, []);

  function openQuickResult(result) {
    setPage(result.page);
    setSearch("");
    setSearchOpen(false);
  }

  async function startRealtime() {
    if (realtimeStarted.current) return;
    realtimeStarted.current = true;

    const channel = supabase
      .channel("ituas-live-data")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, async () => {
        const { data: rows, error } = await supabase.from("profiles").select("*");
        if (!error) setData(prev => ({ ...prev, members: (rows || []).map(mapProfile) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, async () => {
        const { data: rows, error } = await supabase.from("events").select("*").order("event_date", { ascending: true });
        if (!error) setData(prev => ({ ...prev, events: (rows || []).map(mapEvent) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "event_attendance" }, async () => {
        const { data: rows, error } = await supabase.from("event_attendance").select("*").order("updated_at", { ascending: false });
        if (!error) setData(prev => ({ ...prev, eventAttendance: (rows || []).map(mapEventAttendance) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, async () => {
        const { data: rows, error } = await supabase.from("announcements").select("*").order("created_at", { ascending: false });
        if (!error) setData(prev => ({ ...prev, announcements: (rows || []).map(mapAnnouncement) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, async () => {
        const { data: rows, error } = await supabase.from("tasks").select("*").order("due_date", { ascending: true });
        if (!error) setData(prev => ({ ...prev, tasks: (rows || []).map(row => mapTask(row, prev.members)) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "workshop_sessions" }, async () => {
        const { data: rows, error } = await supabase.from("workshop_sessions").select("*").order("check_in", { ascending: false });
        if (!error) setData(prev => ({ ...prev, workshopSessions: (rows || []).map(mapWorkshopSession) }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "team_settings" }, async () => {
        const { data: rows, error } = await supabase.from("team_settings").select("*").limit(1);
        if (!error && rows?.[0]) setData(prev => ({ ...prev, settings: { ...prev.settings, ...mapSettings(rows[0]) } }));
      })
      .subscribe((status) => {
        console.log("Supabase Realtime:", status);
      });

    return () => {
      supabase.removeChannel(channel);
      realtimeStarted.current = false;
    };
  }

  async function loadProfile(authUser) {
    if (!authUser?.id) {
      setData(prev => ({ ...prev, user: null }));
      return;
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, full_name, username, role, department, email, phone, active")
      .eq("id", authUser.id)
      .maybeSingle();

    if (error) {
      console.error("Profil alınamadı:", error);
      setData(prev => ({ ...prev, user: null }));
      return;
    }

    if (!profile) {
      flash("Supabase profil kaydı bulunamadı.");
      await supabase.auth.signOut();
      setData(prev => ({ ...prev, user: null }));
      return;
    }

    if (profile.active === false) {
      flash("Bu hesap pasif durumda.");
      await supabase.auth.signOut();
      setData(prev => ({ ...prev, user: null }));
      return;
    }

    const loggedInUser = {
      id: profile.id,
      name: profile.full_name || authUser.user_metadata?.full_name || "Kullanıcı",
      role: profile.role || "Üye",
      username: profile.username || "",
      email: profile.email || authUser.email || "",
      department: profile.department || "",
    };

    // Girişten hemen sonra bütün ortak veriyi Cloud'dan çek.
    try {
      const cloud = await fetchCloudData();
      setData(prev => ({ ...prev, ...cloud, user: loggedInUser }));
    } catch (err) {
      console.error("Giriş sonrası bulut verileri alınamadı:", err);
      setData(prev => ({ ...prev, user: loggedInUser }));
    }

    await startRealtime();
  }

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session?.user) loadProfile(session.user);
      else setData(prev => ({ ...prev, user: null }));
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (session?.user) {
        setTimeout(() => loadProfile(session.user), 0);
      } else {
        setData(prev => ({ ...prev, user: null }));
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function login(identifier, password) {
    const value = identifier.trim().toLowerCase();

    if (value === "dev") {
      const devProfile = data.members.find(m => m.active);
      if (devProfile) {
        setData(prev => ({ ...prev, user: devProfile }));
        return { success: true };
      }
    }

    if (!value || !password) {
      return { success: false, message: "Kullanıcı adı/e-posta ve şifre gir." };
    }

    let email = value;

    if (!value.includes("@")) {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("email, active")
        .eq("username", value)
        .maybeSingle();

      if (error) {
        console.error(error);
        return { success: false, message: "Profil bilgisi alınamadı." };
      }

      if (!profile?.email) {
        return { success: false, message: "Kullanıcı bulunamadı." };
      }

      if (profile.active === false) {
        return { success: false, message: "Bu hesap pasif durumda." };
      }

      email = profile.email;
    }

    const { data: authData, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error(error);
      return { success: false, message: "Kullanıcı adı veya şifre hatalı." };
    }

    await loadProfile(authData.user);
    return { success: true };
  }

  async function logout() {
    await supabase.auth.signOut();
    setData(prev => ({ ...prev, user: null }));
    setPage("Ana Sayfa");
  }

  useEffect(() => {
    if (!currentUser) return undefined;
    applyWhatsAppApprovals();
    const timer = setInterval(applyWhatsAppApprovals, 4000);
    return () => clearInterval(timer);
  }, [currentUser]);

  const canManage = role === "Yönetici" || role.includes("Kaptan");
  const canAdmin = role === "Yönetici";
  const visibleMenu = canManage ? menu : menu.filter(([, label]) => !["Üyeler", "Raporlar"].includes(label));

  if (!currentUser) {
    return <Login onLogin={login} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/ituas-logo.jpg" className="logo" alt="İTÜAS Otonom Tekne Takımı" />
          <div><strong>İTÜAS OTONOM TEKNE TAKIMI</strong><span>Team Management</span></div>
        </div>

        <nav className="nav">
          <div className="navLabel">MENÜ</div>
          {visibleMenu.map(([icon, label]) => (
            <button key={label} className={`navItem ${page === label ? "active" : ""}`} onClick={() => setPage(label)}>
              <span>{icon}</span>{label}
              {label === "Duyurular" && data.announcements.length > 0 && <b className="badge">{data.announcements.length}</b>}
            </button>
          ))}
          <button className={`navItem ${page === "Atölyem" ? "active" : ""}`} onClick={() => setPage("Atölyem")}>
            <span>⌁</span>{canManage ? "Atölye" : "Atölyem"}
          </button>
          <div className="sideDivider" />
          {canManage && <><div className="navLabel">YÖNETİM</div>
          <button className={`navItem ${page === "Ayarlar" ? "active" : ""}`} onClick={() => setPage("Ayarlar")}>⚙ Ayarlar</button></>}
        </nav>

        <div className="teamQuote">
          <em>“Daha güçlü bir gelecek,<br />birlikte mümkün.”</em>
          <small>İTÜAS Otonom Tekne Takımı</small>
        </div>

        <div className="profileCard" onClick={() => setPage("Profilim")} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setPage("Profilim"); }}>
          <div className="avatar">{currentUser.name[0]}</div>
          <div className="profileText"><strong>{currentUser.name}</strong><span>{currentUser.role}</span></div>
          <button onClick={(event) => { event.stopPropagation(); logout(); }} title="Çıkış">↪</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobileBrand"><img src="/ituas-logo.jpg" alt="" /></div>
          <div ref={searchBoxRef} className="search" style={{position:"relative", zIndex:30}}>
            <span>⌕</span>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setSearchOpen(false); return; }
                if (e.key === "Enter" && quickResults[0]) openQuickResult(quickResults[0]);
              }}
              placeholder="Hızlı ara..."
              aria-label="Hızlı ara"
            />
            {searchOpen && search.trim() && (
              <div style={{
                position:"absolute", top:"calc(100% + 10px)", right:0, width:"min(430px, 88vw)",
                background:"#10151d", border:"1px solid rgba(255,255,255,.10)", borderRadius:14,
                boxShadow:"0 18px 50px rgba(0,0,0,.45)", overflow:"hidden", zIndex:1000
              }}>
                {quickResults.length ? quickResults.map((result, index) => (
                  <button
                    key={`${result.kind}-${result.title}-${index}`}
                    type="button"
                    onClick={() => openQuickResult(result)}
                    style={{
                      width:"100%", display:"flex", alignItems:"center", gap:12, padding:"12px 14px",
                      border:0, borderBottom:index < quickResults.length - 1 ? "1px solid rgba(255,255,255,.06)" : "0",
                      background:"transparent", color:"inherit", textAlign:"left", cursor:"pointer"
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background="rgba(255,157,34,.08)"}
                    onMouseLeave={(e) => e.currentTarget.style.background="transparent"}
                  >
                    <span style={{width:34,height:34,borderRadius:10,display:"grid",placeItems:"center",background:"rgba(255,157,34,.12)",color:"var(--orange,#ff9d22)",flexShrink:0}}>{result.icon}</span>
                    <span style={{minWidth:0,flex:1}}>
                      <strong style={{display:"block",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{result.title}</strong>
                      <small style={{display:"block",marginTop:3,opacity:.58,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{result.sub}</small>
                    </span>
                    <span style={{fontSize:12,opacity:.42}}>↗</span>
                  </button>
                )) : (
                  <div style={{padding:"18px 16px",fontSize:13,opacity:.65}}>Aramanla eşleşen bir kayıt bulunamadı.</div>
                )}
              </div>
            )}
          </div>
          <div className="topUser" onClick={() => setPage("Profilim")} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setPage("Profilim"); }}>
            <span className="bell">♧<i>{data.announcements.length}</i></span>
            <div className="avatar small">{currentUser.name[0]}</div>
            <div><strong>{currentUser.name}</strong><span>{currentUser.role}</span></div>
          </div>
        </header>

        <nav className="mobileNav" aria-label="Mobil menü">
          {[...visibleMenu, ["⌁", canManage ? "Atölye" : "Atölyem"], ...(canManage ? [["⚙", "Ayarlar"]] : [])].map(([icon, label]) => (
            <button
              key={label}
              type="button"
              className={`mobileNavItem ${page === label || (label === "Atölye" && page === "Atölyem") ? "active" : ""}`}
              onClick={() => setPage(label === "Atölye" ? "Atölyem" : label)}
            >
              <span>{icon}</span>
              <small>{label === "Ana Sayfa" ? "Ana Sayfa" : label}</small>
              {label === "Duyurular" && data.announcements.length > 0 && <b>{data.announcements.length}</b>}
            </button>
          ))}
        </nav>

        {page === "Ana Sayfa" && <Dashboard data={data} setPage={setPage} canManage={canManage} flash={flash} />}
        {page === "Takvim" && <CalendarPage data={data} update={update} canManage={canManage} currentUser={currentUser} setData={setData} flash={flash} />}
        {page === "Duyurular" && <AnnouncementsPage data={data} update={update} canManage={canManage} flash={flash} />}
        {page === "Görevler" && <TasksPage data={data} update={update} canManage={canManage} currentUser={currentUser} flash={flash} />}
        {page === "Profilim" && <ProfilePage data={data} update={update} currentUser={currentUser} flash={flash} setPage={setPage} />}
        {page === "Üyeler" && <MembersPage data={data} update={update} canManage={canManage} canAdmin={canAdmin} flash={flash} />}
        {page === "Raporlar" && <ReportsPage data={data} />}
        {page === "Atölyem" && <WorkshopPage data={data} setData={setData} currentUser={currentUser} canManage={canManage} flash={flash} />}
        {page === "Ayarlar" && <SettingsPage data={data} update={update} canAdmin={canAdmin} flash={flash} />}
      </main>

      <style>{dashboardNavStyle}</style>
      {notice && <div className="toast">✓ {notice}</div>}
    </div>
  );
}

function Dashboard({ data, setPage, canManage, flash }) {
  const activeTasks = data.tasks.filter(t => t.status !== "Tamamlandı").length;
  const upcoming = [...data.events].sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4);
  const announcements = data.announcements.slice(0,4);

  return (
    <>
      <section className="hero">
        <div className="heroLogo"><img src="/ituas-logo.jpg" alt="" /></div>
        <div className="heroText"><div className="eyebrow">Hoş geldin 👋</div><h1>{data.settings.teamName}</h1><strong>{data.settings.motto}</strong><p>⚙ İnovasyon &nbsp;|&nbsp; ◉ Takım Ruhu &nbsp;|&nbsp; ✦ STEM &nbsp;|&nbsp; ◇ Gelecek</p></div>
        <div className="heroSlogan">Daha<br /><b>İyi Bir Dünya</b><br />İçin<br />Mühendislik</div>
      </section>

      <div className="statsGrid">
        <StatCard icon="▣" title="Yaklaşan Etkinlik" value={data.events.length} sub="Takvimde kayıtlı" tone="orange" onClick={()=>setPage("Takvim")} />
        <StatCard icon="◈" title="Duyurular" value={data.announcements.length} sub="Yayınlanan duyuru" tone="purple" onClick={()=>setPage("Duyurular")} />
        <StatCard icon="✓" title="Aktif Görev" value={activeTasks} sub="Tamamlanmayı bekliyor" tone="green" onClick={()=>setPage("Görevler")} />
        <StatCard icon="♧" title="Takım Üyesi" value={data.members.filter(m=>m.active).length} sub="Aktif üye" tone="blue" onClick={()=>setPage("Üyeler")} />
      </div>

      <div className="twoCol">
        <section className="panel">
          <PanelHeader title="Yaklaşan Etkinlikler" icon="▣" action="Tümünü Gör" onClick={()=>setPage("Takvim")} />
          {upcoming.length ? upcoming.map(e => <EventRow key={e.id} event={e} onClick={()=>setPage("Takvim")} />) : <Empty text="Henüz etkinlik yok." />}
          <button className="fullLink" onClick={()=>setPage("Takvim")}>Tüm Etkinlikleri Gör →</button>
        </section>
        <section className="panel">
          <PanelHeader title="Son Duyurular" icon="◈" action="Tümünü Gör" onClick={()=>setPage("Duyurular")} />
          {announcements.length ? announcements.map(a => <AnnouncementRow key={a.id} item={a} onClick={()=>setPage("Duyurular")} />) : <Empty text="Henüz duyuru yok." />}
        </section>
      </div>

      <div className="twoCol lower">
        <TaskStatusChart tasks={data.tasks} />
        <section className="panel">
          <h2>Hızlı İşlemler</h2>
          <div className="quickGrid">
            <Quick icon="▣" tone="orange" title="Etkinlik Ekle" sub="Takvime yeni etkinlik" onClick={()=>setPage("Takvim")} disabled={!canManage} />
            <Quick icon="◈" tone="purple" title="Duyuru Yayınla" sub="Takıma bilgi gönder" onClick={()=>setPage("Duyurular")} disabled={!canManage} />
            <Quick icon="✓" tone="green" title="Görev Oluştur" sub="Yeni görev ata" onClick={()=>setPage("Görevler")} disabled={!canManage} />
            <Quick icon="♧" tone="blue" title="Üye Yönet" sub="Takım kadrosu" onClick={()=>setPage("Üyeler")} disabled={!canManage} />
          </div>
        </section>
      </div>
      <footer>© 2026 {data.settings.teamName}. <span>{data.settings.motto} ⚓ İTÜAS</span></footer>
    </>
  );
}

function formatEventDate(value) {
  if (!value) return "Tarih belirtilmedi";
  const d = new Date(value + "T12:00:00");
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", weekday: "long" });
}

function CalendarPage({ data, update, canManage, currentUser, setData, flash }) {
  const [month, setMonth] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ title:"", dates:[new Date().toISOString().slice(0,10)], start:"18:00", end:"20:00", location:"Atölye", type:"Toplantı", description:"" });
  const [attendanceBusy, setAttendanceBusy] = useState(false);

  const managedDeps = getManagedDepartments(currentUser.role);

  const visibleEvents = data.events.filter(e => {
    if (String(e.created_by) === String(currentUser.id)) return true;
    if (e.type === "Müsaitlik") {
      const creator = data.members.find(m => String(m.id) === String(e.created_by));
      if (!creator) return false;
      if (managedDeps === "ALL") return true;
      if (managedDeps.includes(creator.department)) return true;
      return false;
    }
    if (!e.target_departments || e.target_departments.length === 0 || e.target_departments.includes("ALL")) return true;
    if (managedDeps === "ALL") return true;
    if (e.target_departments.includes(currentUser.department)) return true;
    return false;
  });

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    let offset = first.getDay(); offset = offset === 0 ? 6 : offset - 1;
    const total = new Date(month.getFullYear(), month.getMonth()+1, 0).getDate();
    return [...Array(offset).fill(null), ...Array.from({length: total}, (_,i)=>i+1)];
  }, [month]);

  function openNew(day=null) {
    const d = day ? `${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}` : new Date().toISOString().slice(0,10);
    setForm({ title:"", dates:[d], start:"18:00", end:"20:00", location:"Atölye", type:"Toplantı", description:"" });
    setModal({ type:"new" });
  }

  async function save() {
    if (!form.title.trim() || !form.dates || form.dates.length === 0) return;
    
    let hasError = false;
    const createdEvents = [];
    
    for (const d of form.dates) {
        const payload = eventToDb({
          ...form,
          date: d,
          id: "dummy",
          creator: data.user?.name || "Kaptan",
          created_by: data.user?.id || null
        });
        delete payload.id;
        
        const { data: row, error } = await supabase.from("events").insert(payload).select("*").single();
        if (error) {
          hasError = true;
          flash("Bazı etkinlikler eklenirken hata: " + error.message);
          continue;
        }
        createdEvents.push(mapEvent(row));
    }
    
    if (createdEvents.length > 0) {
        update({ events:[...data.events, ...createdEvents] });
        setModal(null);
        flash(createdEvents.length + " etkinlik eklendi.");
    }
  }

  function remove(id) {
    if (!confirm("Bu etkinlik silinsin mi?")) return;
    update({ events:data.events.filter(e=>e.id!==id) }); flash("Etkinlik silindi.");
  }

  const todayKey = new Date().toISOString().slice(0,10);
  const attendanceFor = (eventId) => data.eventAttendance.filter(a => String(a.event_id) === String(eventId));
  const memberById = (id) => data.members.find(m => String(m.id) === String(id));

  function getPlanned(eventId, memberId) {
    return data.eventAttendance.find(a => String(a.event_id) === String(eventId) && String(a.member_id) === String(memberId))?.planned_status || "cevap_vermedi";
  }

  async function setPlanned(event, status) {
    if (!currentUser?.id || attendanceBusy) return;
    setAttendanceBusy(true);
    try {
      const payload = {
        event_id: String(event.id),
        member_id: String(currentUser.id),
        planned_status: status,
      };
      const { data: row, error } = await supabase
        .from("event_attendance")
        .upsert(payload, { onConflict: "event_id,member_id" })
        .select("*")
        .single();
      if (error) throw error;
      setData(prev => ({
        ...prev,
        eventAttendance: [
          ...prev.eventAttendance.filter(a => !(String(a.event_id) === String(event.id) && String(a.member_id) === String(currentUser.id))),
          mapEventAttendance(row),
        ],
      }));
      flash(status === "katilacagim" ? "Katılımın kaydedildi." : status === "katilmayacagim" ? "Katılmayacağın kaydedildi." : "Katılım cevabın temizlendi.");
    } catch (error) {
      console.error("Etkinlik katılımı kaydedilemedi:", error);
      flash("Katılım kaydedilemedi. event_attendance tablosunu oluşturduğundan emin ol.");
    } finally { setAttendanceBusy(false); }
  }

  async function saveActualAttendance(event, values) {
    if (!canManage || event.date >= todayKey || attendanceBusy) return;
    setAttendanceBusy(true);
    try {
      const rows = data.members.filter(m => m.active).map(member => {
        const existing = data.eventAttendance.find(a => String(a.event_id) === String(event.id) && String(a.member_id) === String(member.id));
        return {
          event_id: String(event.id),
          member_id: String(member.id),
          planned_status: existing?.planned_status || "cevap_vermedi",
          actual_status: values[String(member.id)] || null,
        };
      });
      const { data: saved, error } = await supabase
        .from("event_attendance")
        .upsert(rows, { onConflict: "event_id,member_id" })
        .select("*");
      if (error) throw error;
      setData(prev => ({
        ...prev,
        eventAttendance: [
          ...prev.eventAttendance.filter(a => String(a.event_id) !== String(event.id)),
          ...(saved || []).map(mapEventAttendance),
        ],
      }));
      flash("Gerçek katılım kaydedildi.");
    } catch (error) {
      console.error("Gerçek katılım kaydedilemedi:", error);
      flash("Gerçek katılım kaydedilemedi. Yönetici yetkisi / RLS ayarlarını kontrol et.");
    } finally { setAttendanceBusy(false); }
  }

  function EventAttendance({ event }) {
    const rows = attendanceFor(event.id);
    const activeMembers = data.members.filter(m => m.active);
    const getStatus = (memberId) => getPlanned(event.id, memberId);
    const plannedYes = activeMembers.filter(m => getStatus(m.id) === "katilacagim");
    const plannedNo = activeMembers.filter(m => getStatus(m.id) === "katilmayacagim");
    const unanswered = activeMembers.filter(m => getStatus(m.id) === "cevap_vermedi");
    const past = event.date < todayKey;
    const actualRows = rows.filter(r => r.actual_status);
    const came = actualRows.filter(r => r.actual_status === "geldi").length;
    const absent = actualRows.filter(r => r.actual_status === "gelmedi").length;
    const initialActual = Object.fromEntries(activeMembers.map(m => [String(m.id), rows.find(r => String(r.member_id) === String(m.id))?.actual_status || ""]));
    const [actualValues, setActualValues] = useState(initialActual);

    useEffect(() => setActualValues(initialActual), [event.id, data.eventAttendance.length]);

    const memberList = (members, emptyText) => (
      <div className="eventPeopleList">
        {members.length ? members.map(member => (
          <div className="eventPerson" key={member.id}>
            <div className="eventPersonAvatar">{String(member.name || "?").charAt(0).toUpperCase()}</div>
            <div><strong>{member.name}</strong><small>{member.role || member.department || "Takım üyesi"}</small></div>
          </div>
        )) : <div className="eventEmptyPeople">{emptyText}</div>}
      </div>
    );

    return <div className="eventAttendancePremium">
      <section className="eventMyAttendance">
        <h3>Benim Katılımım</h3>
        <div className="eventChoiceGrid">
          <button className={`eventChoice eventChoiceYes ${getStatus(currentUser?.id) === "katilacagim" ? "selected" : ""}`} disabled={attendanceBusy || past} onClick={() => setPlanned(event, "katilacagim")}>
            <span className="eventChoiceIcon">✓</span><span><b>Katılacağım</b><small>Etkinliğe katılacağım</small></span>
          </button>
          <button className={`eventChoice eventChoiceNo ${getStatus(currentUser?.id) === "katilmayacagim" ? "selected" : ""}`} disabled={attendanceBusy || past} onClick={() => setPlanned(event, "katilmayacagim")}>
            <span className="eventChoiceIcon">×</span><span><b>Katılmayacağım</b><small>Etkinliğe katılmayacağım</small></span>
          </button>
          <button className={`eventChoice eventChoiceMaybe ${getStatus(currentUser?.id) === "cevap_vermedi" ? "selected" : ""}`} disabled={attendanceBusy || past} onClick={() => setPlanned(event, "cevap_vermedi")}>
            <span className="eventChoiceIcon">?</span><span><b>Cevap vermedim</b><small>Henüz karar vermedim</small></span>
          </button>
        </div>
      </section>

      <section className="eventSummarySection">
        <h3>Katılım Özeti</h3>
        <div className="eventSummaryGrid">
          <div className="eventSummaryCard eventSummaryGreen"><span>♧</span><div><small>Katılacaklar</small><b>{plannedYes.length}</b><em>kişi</em></div></div>
          <div className="eventSummaryCard eventSummaryRed"><span>♧</span><div><small>Katılmayacaklar</small><b>{plannedNo.length}</b><em>kişi</em></div></div>
          <div className="eventSummaryCard eventSummaryPurple"><span>♧</span><div><small>Cevap yok</small><b>{unanswered.length}</b><em>kişi</em></div></div>
        </div>
      </section>

      <section className="eventPeopleGrid">
        <div className="eventPeopleCard eventPeopleGreen">
          <h4><span>♧</span> Katılacaklar ({plannedYes.length})</h4>
          {memberList(plannedYes, "Henüz katılacağım diyen yok.")}
        </div>
        <div className="eventPeopleCard eventPeopleRed">
          <h4><span>♧</span> Katılmayacaklar ({plannedNo.length})</h4>
          {memberList(plannedNo, "Henüz katılmayacağım diyen yok.")}
        </div>
        <div className="eventPeopleCard eventPeoplePurple">
          <h4><span>♧</span> Cevap vermeyenler ({unanswered.length})</h4>
          {memberList(unanswered, "Herkes cevap verdi.")}
        </div>
      </section>

      <section className="eventActualSection">
        <div className="eventActualHeader">
          <div><span className="eventLock">♙</span><div><h3>Gerçek Katılım</h3><p>Sadece Kaptan ve Yönetici düzenleyebilir.</p></div></div>
          <span className={`eventCompleteBadge ${past ? "done" : ""}`}>{past ? "✓ Etkinlik tamamlandı" : "Etkinlik devam ediyor"}</span>
        </div>

        <div className="eventActualStats">
          <div className="eventActualStat eventActualCame"><span>♙ Gelenler</span><b>{came} / {activeMembers.length}</b></div>
          <div className="eventActualStat eventActualAbsent"><span>♙ Gelmeyenler</span><b>{absent} / {activeMembers.length}</b></div>
        </div>

        {past && canManage ? <>
          <div className="eventActualEditList">
            {activeMembers.map(member => <label key={member.id} className="eventActualRow">
              <div className="eventActualMember"><div className="eventPersonAvatar">{String(member.name || "?").charAt(0).toUpperCase()}</div><div><strong>{member.name}</strong><small>{getStatus(member.id) === "katilacagim" ? "Önceden: Katılacağım" : getStatus(member.id) === "katilmayacagim" ? "Önceden: Katılmayacağım" : "Önceden: Cevap vermedi"}</small></div></div>
              <select value={actualValues[String(member.id)] || ""} onChange={e => setActualValues(v => ({...v, [String(member.id)]: e.target.value}))}>
                <option value="">Belirlenmedi</option><option value="geldi">Geldi</option><option value="gelmedi">Gelmedi</option>
              </select>
            </label>)}
          </div>
          <div className="eventActualActions"><button className="ghost" onClick={() => setActualValues(initialActual)}>Sıfırla</button><button className="primary" disabled={attendanceBusy} onClick={() => saveActualAttendance(event, actualValues)}>{attendanceBusy ? "Kaydediliyor..." : "Kaydet"}</button></div>
        </> : <div className="eventActualInfo">ⓘ Gerçek katılım bilgisi yalnızca etkinlik tarihi geçtikten sonra ve Kaptan/Yönetici tarafından düzenlenebilir.</div>}
      </section>
    </div>;
  }

  return <>
    <style>{`\n.eventPremiumModal{padding:2px 0 0}.eventPremiumTitle{display:flex;align-items:center;gap:14px;margin-bottom:18px}.eventTitleIcon{width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#29184b;color:#c88bff;font-size:24px}.eventPremiumTitle h2{margin:0;font-size:22px;letter-spacing:-.3px}.eventTitleMeta{display:flex;gap:18px;margin-top:7px;color:#9ba6b7;font-size:10px}.eventInfoBar{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #283443;border-radius:12px;background:linear-gradient(145deg,#151d27,#101720);padding:14px 12px;margin-bottom:18px}.eventInfoBar>div{display:flex;align-items:center;gap:9px;padding:0 12px;border-right:1px solid #293442}.eventInfoBar>div:last-child{border-right:0}.eventInfoBar small,.eventInfoBar b{display:block}.eventInfoBar small{font-size:8px;color:#758295;margin-bottom:4px}.eventInfoBar b{font-size:10px;color:#eef2f7}.eventInfoIcon{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex:none}.eventInfoIcon.blue{background:#172b52;color:#6d9cff}.eventInfoIcon.green{background:#123b2b;color:#5fe39c}.eventInfoIcon.orange{background:#402b12;color:#ffb14a}.eventDescription{font-size:10px;color:#8e99aa;line-height:1.5;margin:4px 0 18px}.eventAttendancePremium h3{font-size:15px;margin:0 0 12px}.eventChoiceGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.eventChoice{min-height:90px;border:1px solid #2a3543;background:#111a24;border-radius:10px;color:#fff;text-align:left;padding:14px 16px;display:flex;align-items:center;gap:13px;cursor:pointer}.eventChoice:disabled{cursor:default;opacity:.82}.eventChoice.selected{box-shadow:inset 0 0 0 1px currentColor}.eventChoiceYes.selected{border-color:#42cf89;background:#10261f}.eventChoiceNo.selected{border-color:#e7646c;background:#2a171b}.eventChoiceMaybe.selected{border-color:#a883e9;background:#21192f}.eventChoiceIcon{width:43px;height:43px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:25px;background:#202936;color:#cbd4df;flex:none}.eventChoiceYes .eventChoiceIcon{background:#245c45;color:#61e59a}.eventChoiceNo .eventChoiceIcon{background:#5b2a31;color:#ff858c}.eventChoiceMaybe .eventChoiceIcon{background:#393047;color:#d3c2f6}.eventChoice b,.eventChoice small{display:block}.eventChoice b{font-size:13px}.eventChoice small{font-size:9px;color:#8895a6;margin-top:5px}.eventSummarySection{margin-top:22px}.eventSummaryGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.eventSummaryCard{border:1px solid #2a3543;background:#111923;border-radius:10px;padding:16px;display:flex;gap:13px;align-items:center}.eventSummaryCard>span{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px}.eventSummaryCard small,.eventSummaryCard b,.eventSummaryCard em{display:inline-block}.eventSummaryCard small{display:block;color:#aeb7c5;font-size:10px}.eventSummaryCard b{font-size:24px;margin-top:3px}.eventSummaryCard em{font-style:normal;color:#8591a3;font-size:9px;margin-left:5px}.eventSummaryGreen{border-top:2px solid #42d991}.eventSummaryRed{border-top:2px solid #e9646e}.eventSummaryPurple{border-top:2px solid #a883e9}.eventSummaryGreen>span{background:#123b2b;color:#61e59a}.eventSummaryRed>span{background:#422027;color:#ff858c}.eventSummaryPurple>span{background:#302647;color:#c7b0f5}.eventPeopleGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}.eventPeopleCard{border:1px solid #293544;background:#101923;border-radius:10px;min-height:205px;padding:14px}.eventPeopleCard h4{font-size:11px;margin:0 0 12px}.eventPeopleCard h4 span{margin-right:6px}.eventPeopleGreen{border-top:2px solid #42d991}.eventPeopleRed{border-top:2px solid #e9646e}.eventPeoplePurple{border-top:2px solid #a883e9}.eventPeopleGreen h4{color:#72e7a8}.eventPeopleRed h4{color:#ff858c}.eventPeoplePurple h4{color:#c7b0f5}.eventPeopleList{max-height:150px;overflow:auto}.eventPerson{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid #202a35}.eventPerson:last-child{border-bottom:0}.eventPersonAvatar{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#3a4656,#202936);display:flex;align-items:center;justify-content:center;color:#dce2ea;font-size:11px;font-weight:700;flex:none}.eventPerson strong,.eventPerson small{display:block}.eventPerson strong{font-size:10px}.eventPerson small{font-size:8px;color:#778497;margin-top:2px}.eventEmptyPeople{height:145px;display:flex;align-items:center;justify-content:center;text-align:center;color:#677487;font-size:10px}.eventActualSection{margin-top:18px;border-top:1px dashed #384351;padding-top:18px}.eventActualHeader{display:flex;justify-content:space-between;align-items:center;gap:10px}.eventActualHeader>div{display:flex;align-items:center;gap:10px}.eventActualHeader h3{margin:0;font-size:14px}.eventActualHeader p{margin:4px 0 0;color:#7f8c9e;font-size:9px}.eventLock{font-size:19px;color:#b8c1cf}.eventCompleteBadge{border:1px solid #4b4f70;background:#282642;color:#c4a9ff;border-radius:16px;padding:7px 11px;font-size:9px}.eventCompleteBadge.done{background:#292346;border-color:#7764bc}.eventActualStats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.eventActualStat{padding:13px 15px;border-radius:10px;background:#12251e;border:1px solid #256144}.eventActualStat span,.eventActualStat b{display:block}.eventActualStat span{font-size:9px;color:#8fe9b4}.eventActualStat b{font-size:22px;margin-top:4px}.eventActualAbsent{background:#281a20;border-color:#66333b}.eventActualAbsent span{color:#ff9299}.eventActualEditList{margin-top:12px;border:1px solid #293544;border-radius:10px;overflow:hidden}.eventActualRow{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #222d38;background:#111923}.eventActualRow:last-child{border-bottom:0}.eventActualMember{display:flex;align-items:center;gap:9px}.eventActualMember strong,.eventActualMember small{display:block}.eventActualMember strong{font-size:10px}.eventActualMember small{font-size:8px;color:#758296;margin-top:3px}.eventActualRow select{width:125px;background:#0b1118;border:1px solid #303c4b;color:#fff;border-radius:7px;padding:8px;font-size:9px}.eventActualActions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.eventActualInfo{margin-top:12px;border:1px solid #314e75;background:#132238;color:#9bb7df;border-radius:9px;padding:11px 13px;font-size:9px}.eventDeleteRow{display:flex;justify-content:flex-end;margin-top:15px}.eventPremiumModal .danger{padding:8px 12px}.modal:has(.eventPremiumModal){width:1080px;max-width:96vw;max-height:94vh;padding:26px 24px}.modal:has(.eventPremiumModal) .modalTop{display:flex;position:sticky;top:-26px;z-index:5;margin:-26px -24px 8px;padding:14px 18px 8px;background:linear-gradient(#111820 78%,transparent);justify-content:flex-end}.modal:has(.eventPremiumModal) .modalTop h2{display:none}.modal:has(.eventPremiumModal) .modalTop button{width:40px;height:40px;font-size:25px;border:1px solid #344151;background:#202a35;box-shadow:0 8px 24px #0006}@media(max-width:900px){.eventInfoBar,.eventPeopleGrid,.eventChoiceGrid,.eventSummaryGrid{grid-template-columns:1fr}.eventInfoBar>div{border-right:0;border-bottom:1px solid #293442;padding:10px 4px}.eventInfoBar>div:last-child{border-bottom:0}.eventActualStats{grid-template-columns:1fr}.eventPremiumTitle{align-items:flex-start}}\n`}</style>
    <PageTitle title="Takvim" sub="Takım etkinliklerini planla, düzenle ve takip et." action={<button className="primary" onClick={()=>openNew()}>+ Etkinlik Ekle</button>} />
    <div className="calendarToolbar"><button className="ghost" onClick={()=>setMonth(new Date())}>Bugün</button><div className="monthNav"><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}>‹</button><h2>{monthNames[month.getMonth()]} {month.getFullYear()}</h2><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}>›</button></div><span className="calendarHint">Turuncu çizgi = takım etkinliği</span></div>
    <div className="calendar"><div className="calendarHead">{dayNames.map(d=><b key={d}>{d}</b>)}</div><div className="calendarBody">{days.map((day,i)=>{const key=day?`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`:"";const es=visibleEvents.filter(e=>e.date===key);return <div className="calDay" key={i}><div className="dayTop"><span className="dayNum">{day}</span>{day&&<button onClick={()=>openNew(day)}>+</button>}</div>{es.map(e=><div className="miniEvent" key={e.id} onClick={()=>setModal({type:"view",event:e})}><b>{e.title}</b><small>{e.start} - {e.end}</small><i>{e.location}</i></div>)}</div>})}</div></div>
    {modal?.type==="new" && <Modal title="Etkinlik Ekle" close={()=>setModal(null)}><EventForm form={form} setForm={setForm} save={save} close={()=>setModal(null)} canManage={canManage} /></Modal>}
    {modal?.type==="view" && <Modal title="" close={()=>setModal(null)}><div className="eventPremiumModal">
      <div className="eventPremiumTitle"><div className="eventTitleIcon">✦</div><div><h2>{modal.event.title}</h2><div className="eventTitleMeta"><span>▣ {formatEventDate(modal.event.date)}</span><span>◷ {modal.event.start} - {modal.event.end}</span></div></div></div>
      <div className="eventInfoBar">
        <div><span className="eventInfoIcon blue">📅</span><div><small>Tarih</small><b>{formatEventDate(modal.event.date)}</b></div></div>
        <div><span className="eventInfoIcon blue">🕒</span><div><small>Saat</small><b>{modal.event.start} - {modal.event.end}</b></div></div>
        <div><span className="eventInfoIcon green">📍</span><div><small>Konum</small><b>{modal.event.location || "Belirtilmedi"}</b></div></div>
        <div><span className="eventInfoIcon orange">🏷</span><div><small>Tür</small><b>{modal.event.type || "Etkinlik"}</b></div></div>
      </div>
      {modal.event.description && <p className="eventDescription">{modal.event.description}</p>}
      {!modal.event.description && <p className="eventDescription">Açıklama yok.</p>}
      <EventAttendance event={modal.event}/>
      {canManage&&<div className="eventDeleteRow"><button className="danger" onClick={()=>{remove(modal.event.id);setModal(null)}}>Etkinliği Sil</button></div>}
      {!canManage && String(modal.event.created_by) === String(currentUser.id) && modal.event.type === "Müsaitlik" && <div className="eventDeleteRow"><button className="danger" onClick={()=>{remove(modal.event.id);setModal(null)}}>Sil</button></div>}
    </div></Modal>}
  </>;
}

function EventForm({form,setForm,save,close,canManage}) {
  useEffect(() => {
    if (!canManage && form.type !== "Müsaitlik") {
      setForm(prev => ({ ...prev, type: "Müsaitlik", title: "Müsait Zamanım" }));
    }
  }, [canManage]);

  return <><label>Etkinlik adı<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder={canManage ? "Örn. Robot Çalışması" : "Örn. Müsait Zamanım"}/></label>
  <label>Tarihler (Çoklu gün ekleyebilirsiniz)</label>
  <div style={{display:'grid',gap:'5px',marginBottom:'12px'}}>
    {(form.dates || []).map((d,i) => (
      <div key={i} style={{display:'flex',gap:'5px'}}>
        <input type="date" value={d} onChange={e=>{
           const arr=[...(form.dates||[])]; arr[i]=e.target.value; setForm({...form, dates:arr});
        }} />
        {(form.dates||[]).length > 1 && <button type="button" className="danger" style={{padding:'8px 12px'}} onClick={()=>{
           const arr=[...(form.dates||[])]; arr.splice(i,1); setForm({...form, dates:arr});
        }}>Sil</button>}
      </div>
    ))}
    <button type="button" className="ghost" style={{padding:'8px',fontSize:'11px',justifySelf:'start'}} onClick={()=>setForm({...form, dates:[...(form.dates||[]), (form.dates||[])[(form.dates||[]).length-1] || new Date().toISOString().slice(0,10)]})}>+ Başka Tarih Ekle</button>
  </div>
  <div className="formGrid"><label>Tür<select value={form.type} onChange={e=>setForm({...form,type:e.target.value})} disabled={!canManage}>{canManage ? <><option>Toplantı</option><option>Robot Çalışması</option><option>Eğitim</option><option>Müsabaka</option><option>Etkinlik</option><option>Müsaitlik</option></> : <option>Müsaitlik</option>}</select></label></div><div className="formGrid"><label>Başlangıç<input type="time" value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label>Bitiş<input type="time" value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></div><label>Konum<input value={form.location} onChange={e=>setForm({...form,location:e.target.value})}/></label>{canManage && <label>Kimler Görebilir? (Birden fazla seçebilirsiniz)<select multiple size={3} value={form.target_departments || ["ALL"]} onChange={e=>{ const vals = Array.from(e.target.selectedOptions, o=>o.value); setForm({...form,target_departments:vals}); }}><option value="ALL">Tümü (Herkes)</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}</select></label>}<label>Açıklama<textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><div className="modalActions"><button className="ghost" onClick={close}>Vazgeç</button><button className="primary" onClick={save}>Kaydet</button></div></>;
}

function AnnouncementsPage({data,update,canManage,flash}) {
  const [modal,setModal]=useState(false);
  const [form,setForm]=useState({title:"",body:"",priority:"Normal",pinned:false});
  
  async function save() {
    if(!form.title.trim()) return;
    const payload = announcementToDb({
      ...form,
      id: "dummy",
      date: new Date().toISOString(),
      author: data.user.name,
      author_id: data.user.id || null
    });
    delete payload.id;
    
    const { data: row, error } = await supabase.from("announcements").insert(payload).select("*").single();
    if (error) {
      flash("Duyuru eklenirken hata: " + error.message);
      return;
    }
    
    // OneSignal Push Bildirimi Gönder
    sendPushNotification("📣 Yeni Duyuru: " + form.title, form.body);
    // WhatsApp Bildirimi (Opsiyonel)
    // sendWhatsAppTaskNotification({ title: "Yeni Duyuru", message: form.title });
    
    update({announcements:[mapAnnouncement(row), ...data.announcements]});
    setForm({title:"",body:"",priority:"Normal",pinned:false});
    setModal(false);
    flash("Duyuru yayınlandı.");
  }
  
  function remove(id){if(!confirm("Duyuru silinsin mi?"))return;update({announcements:data.announcements.filter(a=>a.id!==id)});flash("Duyuru silindi.");}
  function pin(id){update({announcements:data.announcements.map(a=>a.id===id?{...a,pinned:!a.pinned}:a)});}
  return <><PageTitle title="Duyurular" sub="Takım içi bilgilendirmeleri tek yerden yönet." action={canManage&&<button className="primary" onClick={()=>setModal(true)}>+ Duyuru Yayınla</button>}/><div className="announcementPage">{data.announcements.sort((a,b)=>Number(b.pinned)-Number(a.pinned)).map(a=><article className="announcementCard" key={a.id}><div className={`annIcon ${a.priority==="Yüksek"?"orange":"purple"}`}>◈</div><div className="annContent"><div className="annTitle"><h3>{a.title}</h3>{a.pinned&&<span className="tag orangeTag">Sabit</span>}</div><p>{a.body}</p><small>{a.author} • {new Date(a.date).toLocaleString("tr-TR")}</small></div><div className="cardActions">{canManage&&<><button onClick={()=>pin(a.id)}>📌</button><button onClick={()=>remove(a.id)}>🗑</button></>}</div></article>)}</div>{modal&&<Modal title="Duyuru Yayınla" close={()=>setModal(false)}><label>Başlık<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>İçerik<textarea value={form.body} onChange={e=>setForm({...form,body:e.target.value})}/></label><div className="formGrid"><label>Öncelik<select value={form.priority} onChange={e=>setForm({...form,priority:e.target.value})}><option>Normal</option><option>Yüksek</option></select></label><label className="checkLabel"><input type="checkbox" checked={form.pinned} onChange={e=>setForm({...form,pinned:e.target.checked})}/> Sabitle</label></div><div className="modalActions"><button className="ghost" onClick={()=>setModal(false)}>Vazgeç</button><button className="primary" onClick={save}>Yayınla</button></div></Modal>}</>;
}

function TasksPage({data,update,canManage,currentUser,flash}) {
  const [modal,setModal]=useState(false);
  const managedDeps = getManagedDepartments(currentUser.role);
  const selectableMembers = data.members.filter(m => m.active && (managedDeps === "ALL" || managedDeps.includes(m.department)));

  const [form,setForm]=useState({
    title:"",
    description:"",
    assignedIds:[],
    due:new Date().toISOString().slice(0,10),
    priority:"Orta",
    status:"Bekliyor"
  });

  function openNew(){
    setForm({
      title:"",
      description:"",
      assignedIds:[],
      due:new Date().toISOString().slice(0,10),
      priority:"Orta",
      status:"Bekliyor"
    });
    setModal(true);
  }

  async function save(){
    if(!form.title.trim() || form.assignedIds.length === 0) {
      flash("Görev adı ve en az bir sorumlu seçmelisiniz.");
      return;
    }

    const newTasks = [];
    for (const aId of form.assignedIds) {
      const assigned = data.members.find(m => String(m.id) === String(aId));
      if (!assigned) continue;

      const payload = {
        title: form.title.trim(),
        description: form.description || "",
        assigned_id: assigned.id || null,
        due_date: form.due || null,
        priority: form.priority || "Orta",
        status: form.status || "Bekliyor",
        created_by: data.user?.id || null,
      };

      const { row, error } = await insertTaskRow(payload);
      if (error) {
        flash("Görev kaydedilemedi: " + (error.message || "bilinmeyen hata"));
        return;
      }
      newTasks.push(mapTask(row, data.members));
    }

    try {
      await update({ tasks: [...data.tasks, ...newTasks] });
    } catch {
      return;
    }

    setModal(false);
    flash(`${newTasks.length} kişiye görev atandı.`);
  }

  const visibleTasks = canManage ? data.tasks.filter(t => {
    if (managedDeps === "ALL") return true;
    const assignee = data.members.find(m => String(m.id) === String(t.assigned_id));
    if (assignee && managedDeps.includes(assignee.department)) return true;
    return String(t.assigned_id) === String(currentUser.id);
  }) : data.tasks.filter(t => String(t.assigned_id) === String(currentUser.id));

  function changeStatus(id,status){update({tasks:data.tasks.map(t=>t.id===id?{...t,status}:t)});flash("Görev durumu güncellendi.");}
  function remove(id){if(!confirm("Görev silinsin mi?"))return;update({tasks:data.tasks.filter(t=>t.id!==id)});flash("Görev silindi.");}
  return <><PageTitle title={canManage ? "Görevler" : "Görevlerim"} sub={canManage ? "Görevleri ata, durumlarını takip et ve tamamla." : "Sadece sana atanmış görevler."} action={canManage&&<button className="primary" onClick={openNew}>+ Görev Oluştur</button>}/><div className="taskCards"><div className="taskBox greenBox"><b>{visibleTasks.filter(t=>t.status==="Tamamlandı").length}</b><span>Tamamlanan</span></div><div className="taskBox orangeBox"><b>{visibleTasks.filter(t=>t.status==="Devam Ediyor").length}</b><span>Devam Eden</span></div><div className="taskBox redBox"><b>{visibleTasks.filter(t=>t.status!=="Tamamlandı"&&new Date(t.due)<new Date()).length}</b><span>Gecikmiş</span></div><div className="taskBox grayBox"><b>{visibleTasks.filter(t=>t.status==="Bekliyor").length}</b><span>Bekleyen</span></div></div><div className="panel"><div className="tableHead"><b>Görev</b><b>Sorumlu</b><b>Son Tarih</b><b>Öncelik</b><b>Durum</b><b></b></div>{visibleTasks.map(t=><div className="tableRow" key={t.id}><div><strong>{t.title}</strong><small>{t.description}</small></div><span>{t.assignee}</span><span>{t.due}</span><span className={`priority ${t.priority.toLowerCase()}`}>{t.priority}</span><select value={t.status} onChange={e=>changeStatus(t.id,e.target.value)}><option>Bekliyor</option><option>Devam Ediyor</option><option>Tamamlandı</option></select>{canManage&&<button className="iconDanger" onClick={()=>remove(t.id)}>🗑</button>}</div>)}{!visibleTasks.length&&<Empty text="Görev bulunmuyor."/>}</div>{modal&&<Modal title="Yeni Görev" close={()=>setModal(false)}><label>Görev<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>Açıklama<textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><div className="formGrid"><label>Sorumlu (Birden fazla seçebilirsiniz)<select multiple size={4} value={form.assignedIds} onChange={e=>{ const vals = Array.from(e.target.selectedOptions, o=>o.value); setForm({...form,assignedIds:vals}); }}>{selectableMembers.map(m=><option key={m.id} value={m.id}>{m.name}{m.phone ? "" : " (telefon yok)"}</option>)}</select></label><label>Son tarih<input type="date" value={form.due} onChange={e=>setForm({...form,due:e.target.value})}/></label></div><div className="formGrid"><label>Öncelik<select value={form.priority} onChange={e=>setForm({...form,priority:e.target.value})}><option>Düşük</option><option>Orta</option><option>Yüksek</option></select></label><label>Durum<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option>Bekliyor</option><option>Devam Ediyor</option><option>Tamamlandı</option></select></label></div><div className="modalActions"><button className="ghost" onClick={()=>setModal(false)}>Vazgeç</button><button className="primary" onClick={save}>Oluştur</button></div></Modal>}</>;
}

function WorkshopPage({ data, setData, currentUser, canManage, flash }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(new Date());
  const ownSessions = data.workshopSessions.filter(s => String(s.member_id) === String(currentUser.id));
  const openSession = ownSessions.find(s => !s.check_out);
  const totals = workshopTotals(ownSessions, now);
  const ownTasks = data.tasks.filter(t => String(t.assigned_id) === String(currentUser.id));
  const overdue = ownTasks.filter(t => t.status !== "Tamamlandı" && t.due && new Date(`${t.due}T23:59:59`) < now);
  const qrUrl = `${window.location.origin}${window.location.pathname}?workshop=${WORKSHOP_QR_TOKEN}`;

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    const token = new URLSearchParams(window.location.search).get("workshop");
    if (token === WORKSHOP_QR_TOKEN) {
      window.history.replaceState({}, document.title, window.location.pathname);
      (async () => {
        setBusy(true);
        try {
          const { data: result, error } = await supabase.rpc("toggle_workshop_session");
          if (error) throw error;
          const { data: rows, error: reloadError } = await supabase.from("workshop_sessions").select("*").order("check_in", { ascending: false });
          if (reloadError) throw reloadError;
          setData(prev => ({ ...prev, workshopSessions: (rows || []).map(mapWorkshopSession) }));
          flash(result?.action === "checked_out" ? "Atölye çıkışın kaydedildi." : "Atölye girişin kaydedildi.");
        } catch (error) {
          console.error("QR ile atölye kaydı başarısız:", error);
          flash("Atölye kaydı oluşturulamadı. Veritabanı geçişini uyguladığından emin ol.");
        } finally { setBusy(false); }
      })();
    }
    return () => clearInterval(timer);
  }, [flash, setData]);

  async function reloadSessions() {
    const { data: rows, error } = await supabase.from("workshop_sessions").select("*").order("check_in", { ascending: false });
    if (error) throw error;
    setData(prev => ({ ...prev, workshopSessions: (rows || []).map(mapWorkshopSession) }));
  }

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const { data: result, error } = await supabase.rpc("toggle_workshop_session");
      if (error) throw error;
      await reloadSessions();
      flash(result?.action === "checked_out" ? "Atölye çıkışın kaydedildi." : "Atölye girişin kaydedildi.");
    } catch (error) {
      console.error("Atölye kaydı başarısız:", error);
      flash("Atölye kaydı oluşturulamadı. Veritabanı geçişini uyguladığından emin ol.");
    } finally { setBusy(false); }
  }

  const activeMembers = data.members.filter(member => data.workshopSessions.some(s => String(s.member_id) === String(member.id) && !s.check_out));
  const sessionsForAdmin = data.workshopSessions.slice(0, 30);
  const memberName = (id) => data.members.find(m => String(m.id) === String(id))?.name || "Bilinmeyen üye";

  return <>
    <PageTitle title={canManage ? "Atölye Yönetimi" : "Atölyem"} sub={canManage ? "Anlık durumu ve giriş-çıkış kayıtlarını takip et." : "Kişisel atölye süren, görevlerin ve kayıtların."}/>
    <section className={`workshopStatus ${openSession ? "inside" : "outside"}`}>
      <div><span>{openSession ? "● ŞU ANDA ATÖLYEDESİN" : "○ ŞU ANDA ATÖLYE DIŞINDASIN"}</span><h2>{openSession ? `Giriş: ${new Date(openSession.check_in).toLocaleString("tr-TR")}` : "QR kodu okutarak giriş yapabilirsin."}</h2><p>{openSession ? `Geçen süre: ${durationText(sessionDuration(openSession, now))}` : "Aynı QR kodu açık bir oturumu kapatmak için de kullanılır."}</p></div>
      <button className="primary workshopToggle" onClick={toggle} disabled={busy}>{busy ? "Kaydediliyor..." : openSession ? "Atölyeden Çıkış Yap" : "Atölyeye Giriş Yap"}</button>
    </section>
    <div className="statsGrid workshopStats"><StatCard icon="◷" title="Bugün" value={durationText(totals.today)} sub="Atölye süresi" tone="orange"/><StatCard icon="▤" title="Bu Hafta" value={durationText(totals.week)} sub="Pazartesiden beri" tone="purple"/><StatCard icon="▥" title="Bu Ay" value={durationText(totals.month)} sub="Bu ayki toplam" tone="green"/><StatCard icon="⌁" title="Toplam" value={durationText(totals.total)} sub={`${ownSessions.length} ziyaret`} tone="blue"/></div>
    <div className="twoCol workshopGrid"><section className="panel"><div className="panelHeader"><h2><span>✓</span>İşlerim</h2></div>{ownTasks.length ? ownTasks.map(task => <div className="workshopRow" key={task.id}><div><strong>{task.title}</strong><small>{task.due ? `Son tarih: ${task.due}` : "Son tarih yok"}</small></div><span className={task.status === "Tamamlandı" ? "statusDone" : overdue.includes(task) ? "statusLate" : "statusOpen"}>{task.status === "Tamamlandı" ? "Tamamlandı" : overdue.includes(task) ? "Gecikmiş" : task.status}</span></div>) : <Empty text="Sana atanmış görev yok."/>}</section>
      <section className="panel"><div className="panelHeader"><h2><span>◷</span>Giriş-Çıkış Geçmişim</h2></div>{ownSessions.length ? ownSessions.slice(0, 8).map(session => <div className="workshopRow" key={session.id}><div><strong>{new Date(session.check_in).toLocaleDateString("tr-TR")}</strong><small>Giriş: {new Date(session.check_in).toLocaleTimeString("tr-TR", {hour:"2-digit", minute:"2-digit"})} · Çıkış: {session.check_out ? new Date(session.check_out).toLocaleTimeString("tr-TR", {hour:"2-digit", minute:"2-digit"}) : "Devam ediyor"}</small></div><b>{durationText(sessionDuration(session, now))}</b></div>) : <Empty text="Henüz atölye kaydın yok."/>}</section></div>
    {canManage && <><div className="pageTitle compact"><div><h1>Yönetici görünümü</h1><p>Atölyedeki üyeler ve en son hareketler.</p></div><button className="ghost" onClick={() => navigator.clipboard?.writeText(qrUrl).then(() => flash("Atölye QR bağlantısı kopyalandı."))}>QR Bağlantısını Kopyala</button></div><section className="panel workshopQr"><img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrUrl)}`} alt="İTÜAS atölye giriş çıkış QR kodu"/><div><h2>Atölye QR Kodu</h2><p>Bu kodu yazdırıp atölye girişine as. Üye, kendi hesabıyla kodu okuttuğunda giriş yapar; açık oturumu varsa çıkışı kaydedilir.</p><small>QR yalnızca atölye bağlantısını taşır; kayıt her zaman oturum açmış üyeye yazılır.</small></div></section><div className="twoCol workshopGrid"><section className="panel"><div className="panelHeader"><h2><span>●</span>Şu An Atölyede ({activeMembers.length})</h2></div>{activeMembers.length ? activeMembers.map(member => { const session = data.workshopSessions.find(s => String(s.member_id) === String(member.id) && !s.check_out); return <div className="workshopRow" key={member.id}><div><strong>{member.name}</strong><small>{member.department} · Giriş: {new Date(session.check_in).toLocaleTimeString("tr-TR", {hour:"2-digit", minute:"2-digit"})}</small></div><b>{durationText(sessionDuration(session, now))}</b></div>; }) : <Empty text="Şu anda atölyede kimse yok."/>}</section><section className="panel"><div className="panelHeader"><h2><span>▤</span>Tüm Son Kayıtlar</h2></div>{sessionsForAdmin.length ? sessionsForAdmin.map(session => <div className="workshopRow" key={session.id}><div><strong>{memberName(session.member_id)}</strong><small>{new Date(session.check_in).toLocaleString("tr-TR")} {session.check_out ? `→ ${new Date(session.check_out).toLocaleTimeString("tr-TR", {hour:"2-digit", minute:"2-digit"})}` : "· İçeride"}</small></div><b>{durationText(sessionDuration(session, now))}</b></div>) : <Empty text="Atölye kaydı yok."/>}</section></div></>}
  </>;
}


function ProfilePage({data, update, currentUser, flash, setPage}) {
  const member = data.members.find(m => String(m.id) === String(currentUser?.id)) || currentUser || {};
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: member.name || "",
    phone: member.phone || "",
    department: member.department || "",
  });

  useEffect(() => {
    setForm({
      name: member.name || "",
      phone: member.phone || "",
      department: member.department || "",
    });
  }, [member.name, member.phone, member.department]);

  const initials = (member.name || "Ü").trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

  const myTasks = data.tasks.filter(task =>
    String(task.assigneeId ?? task.assignee_id ?? task.assignedTo ?? "") === String(member.id)
  );
  const completedTasks = myTasks.filter(task => task.status === "Tamamlandı").length;
  const openTasks = myTasks.filter(task => task.status !== "Tamamlandı").length;
  const overdueTasks = myTasks.filter(task => {
    if (task.status === "Tamamlandı" || !task.due) return false;
    const due = new Date(`${task.due}T23:59:59`);
    return !Number.isNaN(due.getTime()) && due < new Date();
  }).length;

  const myAttendance = data.eventAttendance.filter(item =>
    String(item.memberId ?? item.member_id ?? "") === String(member.id)
  );
  const plannedYes = myAttendance.filter(item => item.plannedStatus === "katilacagim").length;
  const actualPresent = myAttendance.filter(item => item.actualStatus === "geldi").length;

  // Atölye bilgileri profil ile aynı kullanıcıya göre senkron hesaplanır.
  const myWorkshopSessions = (data.workshopSessions || []).filter(session =>
    String(session.member_id ?? session.memberId ?? session.user_id ?? "") === String(member.id)
  );
  const workshopNow = new Date();
  const workshopSummary = workshopTotals(myWorkshopSessions, workshopNow);
  const openWorkshopSession = myWorkshopSessions.find(session => !session.check_out);
  const workshopSessionCount = myWorkshopSessions.length;

  async function save() {
    if (!form.name.trim()) {
      flash("Ad soyad boş bırakılamaz.");
      return;
    }

    setSaving(true);
    try {
      const updatedMembers = data.members.map(item =>
        String(item.id) === String(member.id)
          ? {
              ...item,
              name: form.name.trim(),
              phone: form.phone.trim(),
              department: form.department,
            }
          : item
      );

      await update({
        members: updatedMembers,
        user: {
          ...currentUser,
          name: form.name.trim(),
          phone: form.phone.trim(),
          department: form.department,
        },
      });

      setEditing(false);
      flash("Profilin güncellendi.");
    } catch (error) {
      console.error("Profil güncellenemedi:", error);
      flash("Profil güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageTitle
        title="Profilim"
        sub="Takımdaki kişisel bilgilerini ve kendi aktivitelerini görüntüle."
        action={
          !editing
            ? <button className="primary" onClick={() => setEditing(true)}>✎ Profili Düzenle</button>
            : <div style={{display:"flex", gap:8}}>
                <button className="ghost" onClick={() => setEditing(false)}>Vazgeç</button>
                <button className="primary" onClick={save} disabled={saving}>{saving ? "Kaydediliyor..." : "Kaydet"}</button>
              </div>
        }
      />

      <section className="panel" style={{
        padding: 0,
        overflow: "hidden",
        marginBottom: 18,
        background: "linear-gradient(135deg, rgba(255,157,34,.13), rgba(124,92,255,.08) 55%, rgba(255,255,255,.02))"
      }}>
        <div style={{
          padding: "28px",
          display: "flex",
          alignItems: "center",
          gap: 22,
          flexWrap: "wrap"
        }}>
          <div className="avatar big" style={{
            width: 88,
            height: 88,
            minWidth: 88,
            borderRadius: 24,
            fontSize: 30,
            display: "grid",
            placeItems: "center"
          }}>
            {initials}
          </div>

          <div style={{flex:1, minWidth:240}}>
            <div className="eyebrow">İTÜAS OTONOM TEKNE TAKIMI</div>
            <h2 style={{margin:"5px 0 7px", fontSize:28}}>{member.name || "İsimsiz Üye"}</h2>
            <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
              <span className="tag purple">{member.role || "Üye"}</span>
              <span className="tag">{member.department || "Bölüm belirtilmemiş"}</span>
            </div>
          </div>

          <div style={{
            minWidth:210,
            padding:"15px 17px",
            border:"1px solid rgba(255,255,255,.08)",
            borderRadius:16,
            background:"rgba(0,0,0,.14)"
          }}>
            <small style={{display:"block", opacity:.65, marginBottom:5}}>Hesap</small>
            <strong style={{display:"block", overflow:"hidden", textOverflow:"ellipsis"}}>{member.email || "E-posta belirtilmemiş"}</strong>
            <small style={{display:"block", marginTop:5, opacity:.65}}>@{member.username || "kullanıcı"}</small>
          </div>
        </div>
      </section>

      {editing && (
        <section className="panel" style={{marginBottom:18}}>
          <div className="panelHeader"><h2><span>✎</span>Profil Bilgileri</h2></div>
          <div className="formGrid">
            <label>
              Ad Soyad
              <input value={form.name} onChange={e => setForm({...form, name:e.target.value})} />
            </label>
            <label>
              Telefon
              <input value={form.phone} onChange={e => setForm({...form, phone:e.target.value})} placeholder="05xx xxx xx xx" />
            </label>
          </div>
          <label>
            Bölüm
            <select value={form.department} onChange={e => setForm({...form, department:e.target.value})}>
              {departments.map(department => <option key={department}>{department}</option>)}
            </select>
          </label>
          <p style={{margin:"10px 0 0", opacity:.6, fontSize:13}}>Rol ve e-posta bilgileri yönetici tarafından değiştirilir.</p>
        </section>
      )}

      <div className="statsGrid">
        <StatCard icon="✓" title="Görevlerim" value={myTasks.length} sub={`${openTasks} açık görev`} tone="orange" onClick={() => setPage("Görevler")}/>
        <StatCard icon="✓" title="Tamamlanan" value={completedTasks} sub={`${overdueTasks} gecikmiş`} tone="green" onClick={() => setPage("Görevler")}/>
        <StatCard icon="◷" title="Etkinliklerim" value={plannedYes} sub={`${myAttendance.length} cevaplanan`} tone="purple" onClick={() => setPage("Takvim")}/>
        <StatCard icon="★" title="Gerçek Katılım" value={actualPresent} sub="Geldi olarak işaretlenen" tone="blue" onClick={() => setPage("Takvim")}/>
      </div>

      <section className="panel" style={{marginTop:18}}>
        <div className="panelHeader">
          <h2><span>◷</span>Atölye Bilgilerim</h2>
          <button onClick={() => setPage("Atölyem")}>Atölyeye Git →</button>
        </div>
        <div className="statsGrid workshopProfileStats">
          <StatCard icon="◷" title="Toplam Süre" value={durationText(workshopSummary.total)} sub={`${workshopSessionCount} atölye oturumu`} tone="orange"/>
          <StatCard icon="◫" title="Bu Ay" value={durationText(workshopSummary.month)} sub="Atölye süresi" tone="purple"/>
          <StatCard icon="▤" title="Bu Hafta" value={durationText(workshopSummary.week)} sub="Atölye süresi" tone="blue"/>
          <StatCard icon={openWorkshopSession ? "●" : "○"} title="Durum" value={openWorkshopSession ? "Atölyedesin" : "Atölye dışında"} sub={openWorkshopSession ? `Giriş: ${new Date(openWorkshopSession.check_in).toLocaleString("tr-TR")}` : "Aktif oturum yok"} tone={openWorkshopSession ? "green" : "orange"}/>
        </div>
        <div style={{marginTop:14, padding:"12px 14px", borderRadius:12, border:"1px solid var(--border, rgba(255,255,255,.08))", background:"rgba(255,255,255,.02)", fontSize:13, opacity:.78}}>
          Atölyede geçirdiğin toplam süre, <strong style={{opacity:1}}>{workshopSessionCount}</strong> giriş-çıkış kaydından otomatik hesaplanır ve Atölyem bölümündeki kayıtlarla senkron tutulur.
        </div>
      </section>

      <div className="twoCol" style={{marginTop:18}}>
        <section className="panel">
          <div className="panelHeader">
            <h2><span>✓</span>Görevlerim</h2>
            <button onClick={() => setPage("Görevler")}>Toplam {myTasks.length}</button>
          </div>
          {myTasks.length ? myTasks.slice(0,8).map(task => (
            <div className="workshopRow" key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <small>{task.due ? `Son tarih: ${task.due}` : "Son tarih yok"}</small>
              </div>
              <span className={
                task.status === "Tamamlandı" ? "statusDone" :
                overdueTasks && task.due && new Date(`${task.due}T23:59:59`) < new Date() ? "statusLate" :
                "statusOpen"
              }>
                {task.status}
              </span>
            </div>
          )) : <Empty text="Sana atanmış görev bulunmuyor."/>}
        </section>

        <section className="panel">
          <div className="panelHeader">
            <h2><span>◷</span>Yaklaşan Etkinliklerim</h2>
            <button onClick={() => setPage("Takvim")}>Katılım {plannedYes}</button>
          </div>
          {data.events
            .filter(event => new Date(`${event.date}T23:59:59`) >= new Date())
            .filter(event => myAttendance.some(item => String(item.eventId ?? item.event_id) === String(event.id)))
            .slice(0,6)
            .map(event => {
              const attendance = myAttendance.find(item => String(item.eventId ?? item.event_id) === String(event.id));
              return (
                <div className="workshopRow" key={event.id}>
                  <div>
                    <strong>{event.title}</strong>
                    <small>{event.date} · {event.start}–{event.end}</small>
                  </div>
                  <span className={attendance?.plannedStatus === "katilacagim" ? "statusDone" : "statusLate"}>
                    {attendance?.plannedStatus === "katilacagim" ? "Katılacağım" : attendance?.plannedStatus === "katilmayacagim" ? "Katılmayacağım" : "Cevap yok"}
                  </span>
                </div>
              );
            })}
          {!data.events.some(event =>
            new Date(`${event.date}T23:59:59`) >= new Date() &&
            myAttendance.some(item => String(item.eventId ?? item.event_id) === String(event.id))
          ) && <Empty text="Yaklaşan katılım kaydın bulunmuyor."/>}
        </section>
      </div>

      <section className="panel" style={{marginTop:18}}>
        <div className="panelHeader"><h2><span>▤</span>Hesap Bilgileri</h2></div>
        <div className="formGrid">
          <div><small style={{opacity:.6}}>Kullanıcı adı</small><strong style={{display:"block",marginTop:5}}>@{member.username || "—"}</strong></div>
          <div><small style={{opacity:.6}}>E-posta</small><strong style={{display:"block",marginTop:5}}>{member.email || "—"}</strong></div>
          <div><small style={{opacity:.6}}>Telefon</small><strong style={{display:"block",marginTop:5}}>{member.phone || "Eklenmemiş"}</strong></div>
          <div><small style={{opacity:.6}}>Durum</small><strong style={{display:"block",marginTop:5}}>{member.active === false ? "Pasif" : "Aktif"}</strong></div>
        </div>
      </section>
    </>
  );
}

function MembersPage({data,update,canManage,canAdmin,flash}) {
  const [modal,setModal]=useState(false);
  const [editing,setEditing]=useState(null);
  const blank={name:"",role:"Üye",department:"Mechanical",email:"",phone:"",active:true};
  const [form,setForm]=useState(blank);
  function open(member=null){setEditing(member);setForm(member?{...member}:blank);setModal(true);}
  function save(){
    if(!form.name.trim()) return;

    if(!editing){
      flash("Yeni üye için önce Supabase Auth'ta hesabı oluştur. Sonra üyeyi burada düzenleyebilirsin.");
      return;
    }

    const list = data.members.map(m =>
      m.id === editing.id ? { ...form, id: editing.id } : m
    );

    update({ members: list });
    setModal(false);
    flash("Üye güncellendi.");
  }
  function remove(id){if(!canAdmin)return;if(!confirm("Üye silinsin mi?"))return;update({members:data.members.filter(m=>m.id!==id)});flash("Üye silindi.");}
  return <><PageTitle title="Üyeler" sub="Takım kadrosunu, rollerini ve iletişim bilgilerini yönet." action={canManage&&<button className="primary" onClick={()=>open()}>+ Yeni Üye</button>}/><div className="memberGrid">{data.members.map(m=><div className={`memberCard ${!m.active?"inactive":""}`} key={m.id}><div className="avatar big">{m.name[0]}</div><div className="memberInfo"><strong>{m.name}</strong><span>{m.role} • {m.department}</span><small>{m.email||"E-posta eklenmemiş"}</small><small>{m.phone||"Telefon yok — WhatsApp gitmez"}</small></div>{canManage&&<div className="cardActions"><button onClick={()=>open(m)}>✎</button>{canAdmin&&<button onClick={()=>remove(m.id)}>🗑</button>}</div>}</div>)}</div>{modal&&<Modal title={editing?"Üyeyi Düzenle":"Yeni Üye"} close={()=>setModal(false)}><label>Ad Soyad<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><div className="formGrid"><label>Rol<select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{roles.map(r=><option key={r}>{r}</option>)}</select></label><label>Bölüm<select value={form.department} onChange={e=>setForm({...form,department:e.target.value})}>{departments.map(d=><option key={d}>{d}</option>)}</select></label></div><div className="formGrid"><label>E-posta<input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label><label>Telefon<input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></label></div><label className="checkLabel"><input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}/> Aktif üye</label><div className="modalActions"><button className="ghost" onClick={()=>setModal(false)}>Vazgeç</button><button className="primary" onClick={save}>Kaydet</button></div></Modal>}</>;
}

function TaskStatusChart({ tasks = [] }) {
  const now = new Date();
  now.setHours(23, 59, 59, 999);

  // Kategoriler birbirini tekrar etmez:
  // Tamamlandı > Gecikmiş > Devam Ediyor > Bekliyor.
  const completed = tasks.filter(t => t.status === "Tamamlandı").length;
  const overdue = tasks.filter(t => {
    if (t.status === "Tamamlandı" || !t.due) return false;
    const due = new Date(`${t.due}T23:59:59`);
    return !Number.isNaN(due.getTime()) && due < now;
  }).length;
  const inProgress = tasks.filter(t =>
    t.status === "Devam Ediyor" &&
    !(t.status !== "Tamamlandı" && t.due && new Date(`${t.due}T23:59:59`) < now)
  ).length;
  const waiting = tasks.filter(t =>
    t.status === "Bekliyor" &&
    !(t.due && new Date(`${t.due}T23:59:59`) < now)
  ).length;

  const total = tasks.length;
  const values = [
    { label: "Tamamlanan", value: completed, color: "#56d364" },
    { label: "Devam Eden", value: inProgress, color: "#ff9d22" },
    { label: "Gecikmiş", value: overdue, color: "#ff4d4d" },
    { label: "Bekliyor", value: waiting, color: "#9299a7" },
  ];

  let angle = 0;
  const segments = values
    .filter(item => item.value > 0)
    .map(item => {
      const start = angle;
      angle += (item.value / Math.max(total, 1)) * 360;
      return `${item.color} ${start}deg ${angle}deg`;
    });

  const donutStyle = total
    ? { background: `conic-gradient(${segments.join(", ")})` }
    : { background: "#29303b" };

  return (
    <section className="panel">
      <h2>Görev Durumu</h2>
      <div className="taskChart">
        <div className="donut" style={donutStyle}>
          <div>
            <span>Toplam</span>
            <b>{total}</b>
          </div>
        </div>
        <div className="legend">
          {values.map(item => (
            <Legend
              key={item.label}
              color={item.color}
              label={item.label}
              value={item.value}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ReportsPage({data}) {
  const total=data.tasks.length||1, done=data.tasks.filter(t=>t.status==="Tamamlandı").length;
  const pct=Math.round(done/total*100);
  return <><PageTitle title="Raporlar" sub="Takım faaliyetlerini ve performansını özetle."/><div className="reportGrid"><div className="panel bigMetric"><span>Görev Tamamlama</span><b>{pct}%</b><div className="progress"><i style={{width:`${pct}%`}} /></div></div><div className="panel bigMetric"><span>Etkinlik Sayısı</span><b>{data.events.length}</b><small>Takvimde kayıtlı toplam etkinlik</small></div><div className="panel bigMetric"><span>Aktif Üye</span><b>{data.members.filter(m=>m.active).length}</b><small>Takım kadrosu</small></div><div className="panel bigMetric"><span>Duyuru</span><b>{data.announcements.length}</b><small>Yayınlanan içerik</small></div></div><div className="panel"><h2>Görev Özeti</h2><div className="reportBars">{["Bekliyor","Devam","Tamamlandı"].map((s,i)=><div key={s} style={{height:`${Math.max(18, data.tasks.filter(t=>t.status===(["Bekliyor","Devam Ediyor","Tamamlandı"][i])).length*28)}px`}}><span>{s}</span></div>)}</div></div></>;
}

function SettingsPage({data,update,canAdmin,flash}) {
  const [form,setForm]=useState(data.settings);
  function save(){if(!canAdmin){flash("Ayarları değiştirmek için yönetici olmalısın.");return}update({settings:form});flash("Ayarlar kaydedildi.");}
  function reset(){if(!confirm("Yerel önbellek temizlensin mi? Bulut verileri silinmez."))return;localStorage.removeItem(STORAGE_KEY);location.reload();}
  return <><PageTitle title="Ayarlar" sub="Sistem tercihlerini ve takım bilgilerini düzenle."/><div className="panel settings"><h2>Genel Ayarlar</h2><label>Takım adı<input value={form.teamName} onChange={e=>setForm({...form,teamName:e.target.value})} disabled={!canAdmin}/></label><label>Sistem adı<input value={form.systemName} onChange={e=>setForm({...form,systemName:e.target.value})} disabled={!canAdmin}/></label><label>Slogan<input value={form.motto} onChange={e=>setForm({...form,motto:e.target.value})} disabled={!canAdmin}/></label><label className="checkLabel"><input type="checkbox" checked={form.announcementsEnabled} onChange={e=>setForm({...form,announcementsEnabled:e.target.checked})} disabled={!canAdmin}/> Duyuruları aktif tut</label><div className="modalActions"><button className="danger" onClick={reset}>Yerel Verileri Sıfırla</button><button className="primary" onClick={save} disabled={!canAdmin}>Kaydet</button></div></div></>;
}

function StatCard({icon,title,value,sub,tone,onClick}) {
  const props = onClick ? {
    role: "button",
    tabIndex: 0,
    onClick,
    onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }
  } : {};
  return <div className={`statCard${onClick ? " clickable" : ""}`} {...props}>
    <div className={`statIcon ${tone}`}>{icon}</div>
    <div className="statText"><span>{title}</span><b>{value}</b><small>{sub}</small></div>
    <em>↗</em>
  </div>
}
function EventRow({event,onClick}) {
  const d=new Date(event.date+"T12:00:00");
  return <div className={`eventRow${onClick ? " clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onClick();}} : undefined}>
    <div className="dateBox"><b>{d.getDate()}</b><span>{monthNames[d.getMonth()].slice(0,3).toUpperCase()}</span></div>
    <div className="eventMain"><strong>{event.title}</strong><span>◷ {event.start} - {event.end} &nbsp; ◉ {event.location}</span></div>
    <span className="tag purple">{event.type}</span><span className="rowArrow">›</span>
  </div>
}
function AnnouncementRow({item,onClick}) {
  return <div className={`announcementRow${onClick ? " clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onClick();}} : undefined}>
    <div className={`annIcon ${item.priority==="Yüksek"?"orange":"purple"}`}>◈</div>
    <div><strong>{item.title}</strong><p>{item.body}</p></div>
    <span className="age">{new Date(item.date).toLocaleDateString("tr-TR")}</span>
  </div>
}
function PanelHeader({title,icon,action,onClick}) { return <div className="panelHeader"><h2><span>{icon}</span>{title}</h2><button onClick={onClick}>{action}</button></div> }
function Legend({color,label,value}) { return <div className="legendRow"><i style={{background:color}}/><span>{label}</span><b>{value}</b></div> }
function Quick({icon,tone,title,sub,onClick,disabled}) { return <button className="quick" onClick={onClick} disabled={disabled}><span className={`quickIcon ${tone}`}>{icon}</span><div><strong>{title}</strong><small>{sub}</small></div><b>›</b></button> }
function PageTitle({title,sub,action}) { return <div className="pageTitle"><div><h1>{title}</h1><p>{sub}</p></div>{action&&<div>{action}</div>}</div> }
function Empty({text}) { return <div className="emptyState">{text}</div> }
function Modal({title,close,children}) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div
      className="modalOverlay"
      role="presentation"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title || "Etkinlik detayları"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalTop">
          <h2>{title}</h2>
          <button type="button" aria-label="Kapat" onClick={close}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const monthNames=["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

const dashboardNavStyle = `
.statCard.clickable,.eventRow.clickable,.announcementRow.clickable{cursor:pointer}
.statCard.clickable:hover,.eventRow.clickable:hover,.announcementRow.clickable:hover{transform:translateY(-1px);border-color:rgba(255,145,0,.45)}
.statCard.clickable:focus-visible,.eventRow.clickable:focus-visible,.announcementRow.clickable:focus-visible{outline:2px solid rgba(255,145,0,.8);outline-offset:2px}
`;


const dayNames=["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"];

export default App;
