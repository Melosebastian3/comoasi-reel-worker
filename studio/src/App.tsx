import { useCallback, useEffect, useState } from 'react';
import { api } from '@appdeploy/client';
import {
  Activity,
  CalendarClock,
  Clock3,
  Download,
  Film,
  LayoutDashboard,
  Library,
  Loader2,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type Section = 'Panel' | 'Crear' | 'Biblioteca' | 'Ajustes';
type WorkerHealth = { online: boolean; project: string; fallback: boolean };
type Job = {
  id?: string;
  jobId?: string;
  status: string;
  stage: string;
  progress: number;
  error?: string | null;
  reel_title?: string;
  reel_topic?: string;
  result?: Record<string, unknown>;
};
type PublicationNetworkState = {
  network: string;
  status: string;
  provider?: string | null;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  error?: string | null;
};
type PublicationState = {
  status: string;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  networks?: PublicationNetworkState[];
};
type Reel = {
  id: string;
  category: string;
  topic: string;
  title?: string | null;
  status: string;
  viral_score?: number | null;
  video_object_key?: string | null;
  created_at?: string;
  publication?: PublicationState;
};
type AutomationSlot = {
  key: string;
  time: string;
  category: string;
  market?: 'argentina' | 'random';
  generateAt?: string;
  publishAt?: string;
  scheduledAt?: string;
  status: string;
  jobId?: string | null;
  reelId?: string | null;
  error?: string | null;
  publication?: PublicationState;
};
type TodayPlan = {
  planDate: string;
  timezone: string;
  status: string;
  slots: AutomationSlot[];
};
type AutomationStatus = {
  enabled: boolean;
  connected: boolean;
  renewable?: boolean;
  needsReconnect?: boolean;
  ready: boolean;
  brandId?: string | null;
  brandLabel?: string | null;
  timezone: string;
  networks: string[];
  slots: Array<{ key: string; time: string; market?: 'argentina' | 'random' }>; 
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  todayPlan?: TodayPlan | null;
};
type MetricoolSession = { accessToken: string; refreshToken?: string; expiresAt: number };
type MetricoolBrand = { id: string; label: string; timezone: string; networks: string[] };
type MetricoolContingencyStatus = { connected: boolean; renewable: boolean; ready: boolean; brandId?: string | null; brandLabel?: string | null; timezone: string; networks: string[]; expiresAt?: string | null; lastError?: string | null };
type BufferPostStatus = { id: string; text?: string; status: string; dueAt?: string; channelId?: string; channelService?: string; sentAt?: string | null; externalLink?: string | null; error?: { message?: string; rawError?: string | null; supportUrl?: string | null } | null };
type BufferStatus = { configured: boolean; ready: boolean; channels: { id: string; name: string; service: string; organizationName?: string }[]; missingNetworks: string[]; recentPosts?: BufferPostStatus[]; error?: string };
type SocialNetworkStatus = {
  network: string;
  configured: boolean;
  connected: boolean;
  accountId?: string | null;
  accountLabel?: string | null;
  connectedAt?: string | null;
  review?: string | null;
  missing: string[];
};
type SocialStatus = { networks: SocialNetworkStatus[] };
type SocialOAuthPending = { network: string; state: string; verifier: string; redirectUri: string };

const categories = [
  { key: 'chisme_polemica', label: 'Escándalos / Peleas' },
  { key: 'famosos', label: 'Romances / Rupturas' },
  { key: 'bizarro_wtf', label: 'Papelones / WTF' },
  { key: 'cultura_pop_actualidad', label: 'Egos / Cultura pop' },
];
const nav: Array<{ name: Section; label: string; icon: typeof Activity }> = [
  { name: 'Panel', label: 'Panel', icon: LayoutDashboard },
  { name: 'Crear', label: 'Crear', icon: Film },
  { name: 'Biblioteca', label: 'Biblioteca', icon: Library },
  { name: 'Ajustes', label: 'Ajustes', icon: Settings },
];
const METRICOOL_CLIENT_ID = 'client_1b74aa2c07594a30bbf20f5d1a1efb1a';
const METRICOOL_SESSION_KEY = 'comoasi-metricool-session';
const METRICOOL_BRAND_KEY = 'comoasi-metricool-brand';
const METRICOOL_SELECTION_PENDING_KEY = 'comoasi-metricool-brand-selection-pending';
const SOCIAL_OAUTH_KEY = 'comoasi-social-oauth';

function categoryLabel(value = ''): string {
  return categories.find(item => item.key === value)?.label || value.replaceAll('_', ' ');
}
function savedMetricool(): MetricoolSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(METRICOOL_SESSION_KEY) || 'null') as MetricoolSession | null;
    return value?.accessToken ? { accessToken: 'server-managed', expiresAt: Number.MAX_SAFE_INTEGER } : null;
  } catch { return null; }
}
function randomOAuth(bytes = 32): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function pkce(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function scheduleDefault(): string {
  const date = new Date(Date.now() + 30 * 60000);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function shortTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Argentina/Buenos_Aires' });
}
function slotState(status = ''): { label: string; tone: string } {
  if (status === 'published') return { label: 'Publicado', tone: 'success' };
  if (status === 'scheduled') return { label: 'Programado', tone: 'working' };
  if (status === 'scheduled_partial') return { label: 'Programado parcial', tone: 'warning' };
  if (status === 'publishing') return { label: 'Publicando', tone: 'working' };
  if (status === 'generated' || status === 'ready') return { label: 'Generado', tone: 'neutral' };
  if (status === 'partial') return { label: 'Parcial', tone: 'warning' };
  if (status === 'generating' || status === 'retrying') return { label: 'Generando', tone: 'working' };
  if (status === 'failed' || status === 'overdue') return { label: 'Requiere atención', tone: 'danger' };
  return { label: 'En agenda', tone: 'neutral' };
}

const publicationNetworkLabels: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

function networkSummary(publication?: PublicationState): string {
  const networks = publication?.networks || [];
  if (!networks.length) return '';
  return networks.map(item => {
    const label = publicationNetworkLabels[item.network] || item.network;
    const reason = String(item.error || '').toLowerCase();
    const state = item.status === 'published'
      ? '✓'
      : item.status === 'failed'
        ? reason.includes('limit') || reason.includes('quota') ? 'bloqueado por límite' : 'error'
        : item.status === 'overdue'
          ? 'atrasado'
          : item.status === 'publishing'
            ? 'enviando'
            : item.status === 'scheduled'              ? 'programado'
              : item.status === 'cancelled'
                ? reason.includes('free plan') ? 'sin respaldo (plan Free)' : 'cancelado'
                : 'pendiente';
    return `${label} ${state}`;
  }).join(' · ');
}

function slotDescription(slot: AutomationSlot): string {
  const detail = networkSummary(slot.publication);
  if (slot.status === 'published') return `3/3 redes publicadas${detail ? ` · ${detail}` : ''}`;
  if (slot.status === 'partial') {
    const published = slot.publication?.networks?.filter(item => item.status === 'published').length || 0;
    return `${published}/3 redes publicadas${detail ? ` · ${detail}` : ''}`;
  }
  if (slot.status === 'overdue') return `La hora pasó y todavía falta confirmar la entrega${detail ? ` · ${detail}` : ''}`;
  if (slot.status === 'publishing') return `Enviando a las redes${detail ? ` · ${detail}` : ''}`;
  if (slot.status === 'generating') return 'El Reel se está creando';
  if (slot.status === 'generated') return `Reel generado y sin programación activa${detail ? ` · ${detail}` : ''}`;
  if (slot.status === 'scheduled_partial') {
    const scheduled = slot.publication?.networks?.filter(item => item.status === 'scheduled' || item.status === 'publishing').length || 0;
    return `${scheduled}/3 redes programadas${detail ? ` · ${detail}` : ''}`;
  }
  if (slot.status === 'scheduled') return `Listo para ${shortTime(slot.publication?.scheduledAt || slot.scheduledAt || slot.publishAt)}`;
  if (slot.status === 'failed') return `La publicación requiere atención${detail ? ` · ${detail}` : ''}`;
  return 'Selección automática de famoso y tema';
}

function reelPublicationStatus(reel: Reel): string {
  const publication = reel.publication?.status;
  if (publication && publication !== 'generated') return publication;
  if (reel.status === 'ready') return 'generated';
  return reel.status;
}

function canPublishNow(status: string, publication?: PublicationState): boolean {
  if (status === 'generated') return true;
  if (['overdue', 'failed', 'partial'].includes(status)) return true;
  if (status !== 'scheduled' || !publication?.scheduledAt) return false;
  const scheduledMs = new Date(publication.scheduledAt).getTime();
  return Number.isFinite(scheduledMs) && Date.now() - scheduledMs > 10 * 60 * 1000;
}

function canPublishSlotNow(slot: AutomationSlot): boolean {
  if (['overdue', 'failed', 'partial'].includes(slot.status)) return true;
  if (slot.status !== 'generated') return false;
  const target = slot.publication?.scheduledAt || slot.scheduledAt || slot.publishAt;
  if (!target) return false;
  const targetMs = new Date(target).getTime();
  return Number.isFinite(targetMs) && Date.now() >= targetMs;
}

function App() {
  const [section, setSection] = useState<Section>('Panel');
  const [worker, setWorker] = useState<WorkerHealth | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [library, setLibrary] = useState<Reel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [category, setCategory] = useState('chisme_polemica');
  const [manualTopic, setManualTopic] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishReel, setPublishReel] = useState<Reel | null>(null);
  const [scheduledAt, setScheduledAt] = useState(scheduleDefault());
  const [scheduling, setScheduling] = useState(false);
  const [publishingNowId, setPublishingNowId] = useState<string | null>(null);
  const [metricoolSession, setMetricoolSession] = useState<MetricoolSession | null>(() => savedMetricool());
  const [metricoolBrands, setMetricoolBrands] = useState<MetricoolBrand[]>([]);
  const [metricoolBrandId, setMetricoolBrandId] = useState(() => localStorage.getItem(METRICOOL_BRAND_KEY) || '');
  const [metricoolBusy, setMetricoolBusy] = useState(false);
  const [metricoolMessage, setMetricoolMessage] = useState('');
  const [metricoolContingency, setMetricoolContingency] = useState<MetricoolContingencyStatus | null>(null);
  const [bufferStatus, setBufferStatus] = useState<BufferStatus | null>(null);
  const [socialStatus, setSocialStatus] = useState<SocialStatus | null>(null);
  const [socialBusy, setSocialBusy] = useState<string | null>(null);
  const [socialMessage, setSocialMessage] = useState('');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);

  const refreshAll = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    const [workerResult, automationResult, libraryResult] = await Promise.allSettled([
      api.get('/api/worker/health'),
      api.get('/api/automation/status'),
      api.get('/api/library'),
    ]);
    if (workerResult.status === 'fulfilled') setWorker(workerResult.value.data as WorkerHealth);
    else setWorker({ online: false, project: 'como-asi', fallback: false });
    if (automationResult.status === 'fulfilled') setAutomation(automationResult.value.data as AutomationStatus);
    if (libraryResult.status === 'fulfilled') setLibrary(Array.isArray(libraryResult.value.data) ? libraryResult.value.data as Reel[] : []);
    setUpdatedAt(Date.now());
    setRefreshing(false);
  }, []);

  const loadBufferStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/api/buffer/status');
      const next = data as BufferStatus;
      const failures = (next.recentPosts || []).filter(post => post.status === 'error');
      if (failures.length) console.error('[como-asi-buffer-delivery]', JSON.stringify(failures.map(post => ({ id: post.id, service: post.channelService, dueAt: post.dueAt, message: post.error?.message, rawError: post.error?.rawError, supportUrl: post.error?.supportUrl }))));
      setBufferStatus(next);
    } catch (reason) {
      const detail = reason as { response?: { data?: BufferStatus } };
      setBufferStatus(current => {
        const fallback = detail.response?.data;
        if (current) return { ...current, error: fallback?.error || 'Buffer está limitando consultas temporalmente; el último estado válido se mantiene.' };
        return fallback || { configured: false, ready: false, channels: [], missingNetworks: ['instagram', 'tiktok', 'youtube'], error: 'No pude validar Buffer.' };
      });
    }
  }, []);

  const loadSocialStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/api/social/status');
      setSocialStatus(data as SocialStatus);
    } catch {
      setSocialStatus({ networks: [] });
      setSocialMessage('No pude validar las APIs directas.');
    }
  }, []);

  const loadMetricoolContingency = useCallback(async () => {
    try {
      const { data } = await api.get('/api/metricool/contingency/status');
      const next = data as MetricoolContingencyStatus;
      setMetricoolContingency(next);
      if (next.ready && next.brandId && sessionStorage.getItem(METRICOOL_SELECTION_PENDING_KEY) !== '1') {
        const managed = { accessToken: 'server-managed', expiresAt: Number.MAX_SAFE_INTEGER };
        localStorage.setItem(METRICOOL_SESSION_KEY, JSON.stringify(managed));
        localStorage.setItem(METRICOOL_BRAND_KEY, next.brandId);
        setMetricoolSession(managed);
        setMetricoolBrandId(next.brandId);
        setMetricoolBrands([{ id: next.brandId, label: next.brandLabel || next.brandId, timezone: next.timezone, networks: next.networks }]);
      }
    } catch {
      setMetricoolContingency(current => current || { connected: false, renewable: false, ready: false, brandId: null, brandLabel: null, timezone: 'America/Argentina/Buenos_Aires', networks: ['instagram', 'tiktok', 'youtube'], lastError: 'No pude validar Metricool.' });
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    void loadBufferStatus();
    void loadMetricoolContingency();
    void loadSocialStatus();
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshAll(true);
      void loadMetricoolContingency();
      void loadSocialStatus();
    };
    const timer = window.setInterval(refreshVisible, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [refreshAll, loadBufferStatus, loadMetricoolContingency, loadSocialStatus]);

  useEffect(() => {
    const raw = sessionStorage.getItem(SOCIAL_OAUTH_KEY);
    if (!raw) return;
    const query = new URLSearchParams(location.search);
    const code = query.get('code');
    const returnedState = query.get('state');
    const oauthError = query.get('error');
    if (!code && !oauthError) return;
    history.replaceState({}, '', location.pathname);
    setSection('Ajustes');
    sessionStorage.removeItem(SOCIAL_OAUTH_KEY);
    if (oauthError || !code) {
      setSocialMessage('La autorización de la API directa fue cancelada o rechazada.');
      return;
    }
    try {
      const pending = JSON.parse(raw) as SocialOAuthPending;
      if (!pending.network || pending.state !== returnedState) throw new Error('invalid_state');
      setSocialBusy(pending.network);
      api.post('/api/social/callback', {
        network: pending.network,
        code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.verifier,
      }).then(({ data }) => {
        const result = data as { accountLabel?: string; network?: string };
        setSocialMessage(`${publicationNetworkLabels[pending.network] || pending.network} conectado${result.accountLabel ? `: ${result.accountLabel}` : ''}.`);
        void loadSocialStatus();
      }).catch(() => setSocialMessage('No pude terminar la autorización de la API directa.')).finally(() => setSocialBusy(null));
    } catch {
      setSocialMessage('La autorización directa expiró. Volvé a conectar la red.');
      setSocialBusy(null);
    }
  }, [loadSocialStatus]);

  useEffect(() => {
    if (sessionStorage.getItem(SOCIAL_OAUTH_KEY)) return;    const query = new URLSearchParams(location.search);
    const code = query.get('code');
    const returnedState = query.get('state');
    const oauthError = query.get('error');
    if (!code && !oauthError) return;
    const raw = sessionStorage.getItem('comoasi-metricool-oauth');
    history.replaceState({}, '', location.pathname);
    setSection('Ajustes');
    if (oauthError || !raw) { sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY); setMetricoolMessage('La conexión no se completó. Intentá nuevamente.'); return; }
    sessionStorage.removeItem('comoasi-metricool-oauth');
    try {
      const pending = JSON.parse(raw) as { state: string; verifier: string; redirectUri: string };
      if (pending.state !== returnedState) throw new Error('invalid_state');
      setMetricoolBusy(true);
      api.post('/api/metricool/oauth/token', { code, verifier: pending.verifier, redirectUri: pending.redirectUri }).then(({ data }) => {
        const token = data as { accessToken?: string; refreshToken?: string; expiresIn?: number };
        if (!token.accessToken) throw new Error('missing_token');
        const session: MetricoolSession = { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: Date.now() + Number(token.expiresIn || 3600) * 1000 };
        sessionStorage.setItem(METRICOOL_SELECTION_PENDING_KEY, '1');
        setMetricoolBrands([]);
        setMetricoolBrandId('');
        setMetricoolSession(session);
        setMetricoolMessage('Cuenta autorizada temporalmente. Cargando marcas; nada se guardará hasta que confirmes una.');
      }).catch(() => { sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY); setMetricoolMessage('No pude terminar la conexión. Intentá nuevamente.'); }).finally(() => setMetricoolBusy(false));
    } catch { sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY); setMetricoolMessage('La conexión expiró. Intentá nuevamente.'); }
  }, []);

  useEffect(() => {
    if (!metricoolSession?.accessToken || metricoolSession.accessToken === 'server-managed') return;
    let active = true;
    setMetricoolBusy(true);
    api.post('/api/metricool/oauth/brands', { accessToken: metricoolSession.accessToken }).then(({ data }) => {
      if (!active) return;
      const brands = (data as { brands?: MetricoolBrand[] }).brands || [];
      setMetricoolBrands(brands);
      setMetricoolBrandId('');
      setMetricoolMessage(brands.length ? 'Elegí la marca que querés usar. La conexión actual sigue intacta hasta que confirmes.' : 'No encontré una marca en esta cuenta; la conexión actual no fue modificada.');
    }).catch(() => setMetricoolMessage('No pude cargar las marcas de Metricool.')).finally(() => { if (active) setMetricoolBusy(false); });
    return () => { active = false; };
  }, [metricoolSession?.accessToken]);

  const activateMetricoolBrand = async () => {
    const brand = metricoolBrands.find(item => item.id === metricoolBrandId);
    if (!metricoolSession?.accessToken || metricoolSession.accessToken === 'server-managed' || !brand) {
      setMetricoolMessage('Elegí una marca antes de guardar la conexión.');
      return;
    }
    setMetricoolBusy(true);
    try {
      await api.post('/api/metricool/oauth/automation', {
        accessToken: metricoolSession.accessToken,
        refreshToken: metricoolSession.refreshToken || '',
        expiresIn: Math.max(60, Math.floor((metricoolSession.expiresAt - Date.now()) / 1000)),
        brandId: brand.id,
        brandLabel: brand.label,
        timezone: brand.timezone || 'America/Argentina/Buenos_Aires',
        networks: ['instagram', 'tiktok', 'youtube'],
      });
      const managed = { accessToken: 'server-managed', expiresAt: Number.MAX_SAFE_INTEGER };
      localStorage.setItem(METRICOOL_SESSION_KEY, JSON.stringify(managed));
      localStorage.setItem(METRICOOL_BRAND_KEY, brand.id);
      sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY);
      setMetricoolSession(managed);
      setMetricoolMessage(`Metricool quedó conectado con ${brand.label} como publisher principal y su sesión se renovará automáticamente.`);
      await loadMetricoolContingency();
    } catch {
      setMetricoolMessage('La cuenta se conectó, pero no pude activar la marca seleccionada como publisher principal.');
    } finally {
      setMetricoolBusy(false);
    }
  };

  const cancelMetricoolBrandSelection = async () => {
    sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY);
    setMetricoolBrands([]);
    setMetricoolBrandId(localStorage.getItem(METRICOOL_BRAND_KEY) || '');
    setMetricoolSession(savedMetricool());
    setMetricoolMessage('Cambio de marca cancelado. La conexión anterior sigue activa.');
    await loadMetricoolContingency();
  };

  useEffect(() => {
    const mobileNavigator = navigator as Navigator & { standalone?: boolean };
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || mobileNavigator.standalone === true);
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    const onInstalled = () => { setIsStandalone(true); setInstallPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);

  useEffect(() => {
    if (job) return;
    const id = localStorage.getItem('comoasi-active-job');
    if (!id) return;
    api.get(`/api/jobs/${id}`).then(({ data }) => {
      const restored = data as Job;
      setJob(restored);
      setBusy(restored.status !== 'completed' && restored.status !== 'failed');
    }).catch(() => localStorage.removeItem('comoasi-active-job'));
  }, [job]);

  useEffect(() => {
    const id = job?.id || job?.jobId;
    if (!id || job?.status === 'completed' || job?.status === 'failed') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { data } = await api.get(`/api/jobs/${id}`);
        if (cancelled) return;
        const next = data as Job;
        setJob(next);
        if (next.status === 'completed' || next.status === 'failed') {
          setBusy(false);
          void refreshAll(true);
        }
      } catch { if (!cancelled) setNotice('El proceso continúa en el servidor. Actualizaremos al recuperar conexión.'); }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.id, job?.jobId, job?.status, refreshAll]);

  const connectBuffer = async () => {
    window.open('https://publish.buffer.com', '_blank', 'noopener,noreferrer');
    await loadBufferStatus();
  };

  const connectMetricool = async () => {
    setMetricoolBusy(true);
    setMetricoolMessage('');
    try {
      const verifier = randomOAuth(48);
      const state = randomOAuth(24);
      const redirectUri = `${window.location.origin}${window.location.pathname}`;
      const challenge = await pkce(verifier);
      setMetricoolBrands([]);
      setMetricoolBrandId('');
      sessionStorage.setItem('comoasi-metricool-oauth', JSON.stringify({ state, verifier, redirectUri }));
      const url = new URL('https://app.metricool.com/oauth/authorize');
      Object.entries({ response_type: 'code', client_id: METRICOOL_CLIENT_ID, redirect_uri: redirectUri, scope: 'mcp:read mcp:write', state, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://ai.metricool.com/mcp' }).forEach(([key, value]) => url.searchParams.set(key, value));
      window.location.assign(url.toString());
    } catch {
      sessionStorage.removeItem(METRICOOL_SELECTION_PENDING_KEY);
      setMetricoolBusy(false);
      setMetricoolMessage('No pude abrir Metricool. Intentá nuevamente.');
    }
  };

  const connectNative = async (network: string) => {
    setSocialBusy(network);
    setSocialMessage('');
    const state = randomOAuth(24);
    const verifier = randomOAuth(48);
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    try {
      const codeChallenge = network === 'youtube' ? await pkce(verifier) : '';
      const pending: SocialOAuthPending = { network, state, verifier, redirectUri };
      sessionStorage.setItem(SOCIAL_OAUTH_KEY, JSON.stringify(pending));
      const { data } = await api.post('/api/social/connect', { network, redirectUri, state, codeChallenge });
      const result = data as { authorizationUrl?: string; missing?: string[] };
      const authorizationUrl = String(result.authorizationUrl || '');
      if (!authorizationUrl) throw new Error('authorization_url_missing');
      window.location.assign(authorizationUrl);
    } catch (reason) {
      sessionStorage.removeItem(SOCIAL_OAUTH_KEY);
      const detail = reason as { data?: { missing?: string[] }; response?: { data?: { missing?: string[] } } };
      const missing = detail.data?.missing || detail.response?.data?.missing || [];
      setSocialMessage(missing.length
        ? `Faltan credenciales de desarrollador: ${missing.join(', ')}.`
        : 'No pude iniciar la conexión directa.');
      setSocialBusy(null);
      await loadSocialStatus();
    }
  };

  const disconnectNative = async (network: string) => {
    setSocialBusy(network);
    try {
      await api.post('/api/social/disconnect', { network });
      setSocialMessage(`${publicationNetworkLabels[network] || network} desconectado del Nivel 4.`);
      await loadSocialStatus();
    } catch {
      setSocialMessage('No pude desconectar la cuenta directa.');
    } finally {
      setSocialBusy(null);
    }
  };

  const toggleAutomation = async () => {
    if (!automation?.connected) return;
    setMetricoolBusy(true);
    try {
      await api.post('/api/automation/enabled', { enabled: !automation.enabled });
      setMetricoolMessage(automation.enabled ? 'Autopiloto pausado.' : 'Autopiloto activado.');
      await refreshAll(true);
    } catch { setMetricoolMessage('No pude cambiar el estado del autopiloto.'); }
    finally { setMetricoolBusy(false); }
  };
  const startGeneration = async () => {
    if (!worker?.online) { setNotice('El generador no está disponible por el momento.'); return; }
    setBusy(true);
    setNotice('');
    try {
      const payload: Record<string, string> = { category };
      if (manualTopic.trim()) payload.topic = manualTopic.trim();
      const { data } = await api.post('/api/generate', payload);
      const next = data as Job;
      setJob(next);
      localStorage.setItem('comoasi-active-job', String(next.id || next.jobId));
      setNotice('Reel iniciado. Podés cerrar la app: continuará en segundo plano.');
    } catch { setBusy(false); setNotice('No pude iniciar el Reel. Intentá nuevamente.'); }
  };

  const retryJob = async () => {
    const id = job?.id || job?.jobId;
    if (!id) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/api/jobs/${id}/retry`, {});
      setJob(data as Job);
      setNotice('Reintento iniciado en segundo plano.');
    } catch { setBusy(false); setNotice('No pude reintentar el Reel.'); }
  };

  const openVideo = async (reel: Reel) => {
    if (!reel.video_object_key) return;
    try {
      const { data } = await api.post('/api/assets/url', { path: reel.video_object_key });
      const url = String((data as { url?: string }).url || '');
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch { setNotice('No pude abrir el video.'); }
  };

  const scheduleReel = async () => {
    if (!publishReel) return;
    const date = new Date(scheduledAt);
    if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 5 * 60000) { setNotice('Elegí una fecha al menos 5 minutos hacia adelante.'); return; }
    setScheduling(true);
    try {
      const { data } = await api.post('/api/buffer/schedule', {
        reelId: publishReel.id,
        scheduledAt: date.toISOString(),
        timezone: automation?.timezone || 'America/Argentina/Buenos_Aires',
        networks: ['instagram', 'tiktok', 'youtube'],
      });
      const plannerUrl = String((data as { plannerUrl?: string }).plannerUrl || '');
      setPublishReel(null);
      setSuccess('Programado en Instagram, TikTok y YouTube.');
      window.setTimeout(() => setSuccess(''), 6000);
      if (plannerUrl) window.open(plannerUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      const reason = error as { data?: { detail?: string }; response?: { data?: { detail?: string } } };
      setNotice(reason.data?.detail || reason.response?.data?.detail || 'Buffer no pudo programarlo. Intentá nuevamente.');
    } finally { setScheduling(false); }
  };

  const publishNow = async (reelId: string) => {
    setPublishingNowId(reelId);
    setNotice('');
    try {
      const { data } = await api.post('/api/publisher/publish-now', {
        reelId,
        networks: ['instagram', 'tiktok', 'youtube'],
      });
      const result = data as { alreadyPublished?: boolean; accepted?: boolean; partial?: boolean; message?: string; blockedNetworks?: string[] };
      const message = result.alreadyPublished
        ? 'Este Reel ya estaba publicado en las tres redes.'
        : result.message
          || (result.accepted
            ? 'Contingencia iniciada. Voy actualizando cada red automáticamente.'
            : result.partial && result.blockedNetworks?.length
              ? `Publicación parcial. Pendiente: ${result.blockedNetworks.join(', ')}.`
              : 'Publicación manual enviada de forma segura.');
      setSuccess(message);
      window.setTimeout(() => setSuccess(''), 9000);
      await refreshAll(true);
      window.setTimeout(() => void refreshAll(true), 5000);
      window.setTimeout(() => void refreshAll(true), 15000);
      window.setTimeout(() => void refreshAll(true), 30000);
    } catch (error) {
      const reason = error as {
        data?: { detail?: string; error?: string; duplicateSafe?: boolean };
        response?: { status?: number; data?: { detail?: string; error?: string; duplicateSafe?: boolean } };
        status?: number;
        message?: string;
      };
      const payload = reason.data || reason.response?.data;
      const status = reason.response?.status ?? reason.status;
      const detail = payload?.detail || reason.message || '';
      const rateLimited = status === 429
        || payload?.error === 'buffer_rate_limited_manual_publish_blocked'
        || detail.includes('429')
        || detail.toLowerCase().includes('too many requests');
      setNotice(rateLimited
        ? 'Buffer está limitado temporalmente (429). No se publicó para evitar duplicados. El Reel sigue pendiente; volvé a intentar cuando se libere el límite.'
        : detail || 'No pude publicar ahora. No se generó un duplicado.');
    } finally {
      setPublishingNowId(null);
    }
  };

  const installApp = async () => {
    if (!installPrompt) { setNotice('En el menú del navegador elegí “Agregar a pantalla principal”.'); return; }
    await installPrompt.prompt();
    setInstallPrompt(null);
  };

  const failedBufferPosts = (bufferStatus?.recentPosts || []).filter(post => post.status === 'error');
  const planSlots = automation?.todayPlan?.slots || [];
  const attentionSlots = planSlots.filter(slot => ['partial', 'scheduled_partial', 'overdue', 'failed'].includes(slot.status));
  const deliveryAttention = attentionSlots.length > 0;
  const active = Boolean(worker?.online && automation?.ready && automation.enabled && !automation.lastError);
  const readyReels = library.filter(reel => reel.status === 'ready' && reel.video_object_key);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><span>MALA FAMA</span><strong>¿CÓMO ASÍ?</strong></div>
        <div className={`live-pill ${active ? 'on' : ''}`}>{active ? <Wifi size={15} /> : <WifiOff size={15} />}{active ? 'Autopiloto activo' : 'Revisar sistema'}</div>
      </header>

      {section === 'Panel' && (
        <section className="page">
          <div className="page-heading"><div><span className="kicker">PUBLICACIÓN AUTOMÁTICA</span><h1>Hoy</h1></div><button className="icon-button" aria-label="Actualizar" onClick={() => void refreshAll()} disabled={refreshing}>{refreshing ? <Loader2 className="spin" /> : <RefreshCw />}</button></div>

          <article className={`autopilot-card ${active ? 'active' : ''} ${deliveryAttention ? 'attention' : ''}`}>
            <div className="autopilot-copy"><span className="status-dot" /><div><strong>{deliveryAttention ? 'Hay publicaciones para revisar' : active ? 'Todo funcionando' : automation?.enabled === false ? 'Autopiloto pausado' : 'Terminando configuración'}</strong><p>{deliveryAttention ? `${attentionSlots.length} publicación${attentionSlots.length === 1 ? '' : 'es'} con entrega pendiente. Usá Publicar ahora donde sea seguro.` : active ? 'Generamos, programamos y confirmamos la entrega en cada red.' : 'Revisá Ajustes para dejar la publicación activa.'}</p></div></div>
            <div className="network-row"><span>Instagram</span><span>TikTok</span><span>YouTube</span></div>
          </article>
          {failedBufferPosts.length > 0 && <div className="inline-alert">Buffer detectó {failedBufferPosts.length} publicación{failedBufferPosts.length === 1 ? '' : 'es'} fallida{failedBufferPosts.length === 1 ? '' : 's'}. {failedBufferPosts.slice(0, 3).map(post => `${post.channelService || 'red'}: ${post.error?.message || post.error?.rawError || 'error de publicación'}`).join(' · ')} <button onClick={() => setSection('Ajustes')}>Ver estado</button></div>}
          {notice && <div className="inline-alert publish-feedback">{notice}</div>}

          <div className="section-title"><h2>Próximas publicaciones</h2><span>3 por día</span></div>
          <div className="schedule-list">
            {(planSlots.length ? planSlots : (automation?.slots || []).map((slot, index) => ({ ...slot, category: categories[index]?.key || 'chisme_polemica', market: index === 1 ? 'random' : 'argentina', status: 'planned' }))).slice(0, 3).map(slot => {
              const state = slotState(slot.status);
              const publishable = Boolean(slot.reelId && canPublishSlotNow(slot));
              return (
                <article className="schedule-card" key={slot.key}>
                  <div className="time-box"><Clock3 size={18} /><strong>{slot.time}</strong></div>
                  <div className="schedule-copy"><strong>{categoryLabel(slot.category)} · {slot.market === 'argentina' ? '🇦🇷 Argentina' : '🌎 Random'}</strong><span>{slotDescription(slot)}</span></div>
                  <div className="schedule-actions">
                    <span className={`state ${state.tone}`}>{state.label}</span>
                    {publishable && <button className="publish-now-mini" disabled={publishingNowId === slot.reelId} onClick={() => void publishNow(String(slot.reelId))}>{publishingNowId === slot.reelId ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Publicar ahora</button>}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="section-title"><h2>Últimos Reels</h2><button onClick={() => setSection('Biblioteca')}>Ver todos</button></div>
          <div className="recent-list">
            {library.slice(0, 3).map(reel => <button key={reel.id} className="recent-reel" onClick={() => void openVideo(reel)}><span className="thumb"><Play size={18} /></span><span><strong>{reel.title || reel.topic}</strong><small>{categoryLabel(reel.category)} · {slotState(reelPublicationStatus(reel)).label}</small></span><span className="chevron">›</span></button>)}
            {!library.length && <div className="empty">Los Reels aparecerán aquí cuando termine el primer render.</div>}
          </div>
          {automation?.lastError && <div className="inline-alert">El sistema detectó un inconveniente de publicación y seguirá reintentando de forma segura. <button onClick={() => setSection('Ajustes')}>Ver estado</button></div>}
        </section>
      )}

      {section === 'Crear' && (
        <section className="page narrow">
          <div className="page-heading"><div><span className="kicker">CREACIÓN OPCIONAL</span><h1>Crear un Reel extra</h1></div></div>
          <p className="lead">El autopiloto ya crea tres por día. Usá esto solo cuando quieras sumar un tema puntual.</p>
          <div className="form-card">
            <label>Categoría<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
            <label>Tema <span>opcional</span><input value={manualTopic} onChange={event => setManualTopic(event.target.value)} placeholder="Vacío = elegimos el tema más fuerte" /></label>
            <button className="primary" onClick={() => void startGeneration()} disabled={busy || !worker?.online}>{busy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}{manualTopic.trim() ? 'Crear este Reel' : 'Buscar tema y crear'}</button>
          </div>
          {job && <article className="job-card"><div className="job-title"><div><span>EN PROCESO</span><strong>{job.reel_title || job.reel_topic || 'Reel en producción'}</strong></div><strong>{job.progress || 0}%</strong></div><div className="progress"><span style={{ width: `${Math.max(2, Number(job.progress || 0))}%` }} /></div><p>{job.status === 'failed' ? 'La generación se detuvo.' : 'Continúa aunque cierres o bloquees el dispositivo.'}</p>{job.error && <div className="error-detail">{job.error}</div>}{job.status === 'failed' && <button className="secondary" onClick={() => void retryJob()}><RotateCcw size={17} /> Reintentar</button>}{job.status === 'completed' && <button className="secondary" onClick={() => setSection('Biblioteca')}><Library size={17} /> Ver resultado</button>}</article>}
          {notice && <div className="notice">{notice}</div>}
        </section>
      )}

      {section === 'Biblioteca' && (
        <section className="page">
          <div className="page-heading"><div><span className="kicker">CONTENIDO TERMINADO</span><h1>Biblioteca</h1></div><button className="icon-button" aria-label="Actualizar" onClick={() => void refreshAll()} disabled={refreshing}>{refreshing ? <Loader2 className="spin" /> : <RefreshCw />}</button></div>
          <p className="lead">{readyReels.length} Reels listos · actualizado {updatedAt ? shortTime(new Date(updatedAt).toISOString()) : 'ahora'}</p>
          <div className="reel-grid">{library.map(reel => {
            const publicationStatus = reelPublicationStatus(reel);
            const lifecycle = slotState(publicationStatus);
            const publishable = Boolean(reel.video_object_key && canPublishNow(publicationStatus, reel.publication));
            const deliveryDetail = networkSummary(reel.publication);
            return <article className="reel-card" key={reel.id}><div className="reel-meta"><span>{categoryLabel(reel.category)}</span><span className={`state ${lifecycle.tone}`}>{lifecycle.label}</span></div><h2>{reel.title || reel.topic}</h2>{reel.viral_score != null && <p>Potencial viral {reel.viral_score}/100</p>}{deliveryDetail && <p className="delivery-detail">{deliveryDetail}</p>}<div className="reel-actions"><button className="secondary" disabled={!reel.video_object_key} onClick={() => void openVideo(reel)}><Play size={17} /> Ver</button><button className="secondary" disabled={!automation?.ready || !reel.video_object_key || publicationStatus === 'published'} onClick={() => { setScheduledAt(scheduleDefault()); setPublishReel(reel); }}><CalendarClock size={17} /> Programar</button>{publishable && <button className="primary small publish-now" disabled={publishingNowId === reel.id} onClick={() => void publishNow(reel.id)}>{publishingNowId === reel.id ? <Loader2 className="spin" size={17} /> : <Send size={17} />} Publicar ahora</button>}</div></article>;
          })}</div>
          {!library.length && <div className="empty large">Todavía no hay Reels terminados.</div>}
          {notice && <div className="notice">{notice}</div>}
        </section>
      )}

      {section === 'Ajustes' && (
        <section className="page narrow">
          <div className="page-heading"><div><span className="kicker">CONFIGURACIÓN</span><h1>Ajustes</h1></div></div>
          <article className="settings-card"><div className="settings-head"><span className="settings-icon"><ShieldCheck /></span><div><strong>Metricool · principal</strong><p>{metricoolContingency?.ready ? `Publisher principal conectado · ${metricoolContingency.brandLabel || 'Mala Fama'} · renovación automática activa` : 'Publisher principal. Si no puede entregar, el sistema pasa a Buffer sin duplicar el Reel.'}</p></div><span className={`state ${metricoolContingency?.ready ? 'success' : 'warning'}`}>{metricoolContingency?.ready ? 'Principal' : 'Conectar'}</span></div>{metricoolSession?.accessToken && metricoolSession.accessToken !== 'server-managed' && metricoolBrands.length > 0 && <div className="notice compact"><label>Marca de Metricool<select value={metricoolBrandId} onChange={event => setMetricoolBrandId(event.target.value)}><option value="">Seleccioná una marca</option>{metricoolBrands.map(brand => <option key={brand.id} value={brand.id}>{brand.label} · {brand.id}</option>)}</select></label><button className="primary full" disabled={metricoolBusy || !metricoolBrandId} onClick={() => void activateMetricoolBrand()}>{metricoolBusy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />} Usar esta marca</button><button className="secondary full" disabled={metricoolBusy} onClick={() => void cancelMetricoolBrandSelection()}>Cancelar cambio</button></div>}{!(metricoolSession?.accessToken && metricoolSession.accessToken !== 'server-managed') && <button className={metricoolContingency?.ready ? 'secondary full' : 'primary'} disabled={metricoolBusy} onClick={() => void connectMetricool()}>{metricoolBusy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />} {metricoolContingency?.ready ? 'Cambiar marca' : 'Conectar Metricool'}</button>}{metricoolContingency?.lastError && <div className="notice compact">{metricoolContingency.lastError}</div>}{metricoolMessage && <div className="notice compact">{metricoolMessage}</div>}</article>

          <article className="settings-card"><div className="settings-head"><span className="settings-icon"><ShieldCheck /></span><div><strong>Buffer · respaldo #2</strong><p>{bufferStatus?.ready ? `Segundo publisher listo · ${bufferStatus.channels.map(channel => channel.service).join(' · ')}` : bufferStatus?.missingNetworks?.length ? `Segundo respaldo incompleto · falta: ${bufferStatus.missingNetworks.join(', ')}` : 'Validando el segundo respaldo…'}</p></div><span className={`state ${bufferStatus?.ready ? 'success' : 'danger'}`}>{bufferStatus?.ready ? 'Listo' : 'Revisar'}</span></div>{!bufferStatus?.ready && <button className="primary" onClick={() => void connectBuffer()}><ShieldCheck size={18} /> Abrir Buffer</button>}{bufferStatus?.error && <div className="notice compact">{bufferStatus.error}</div>}</article>

          <article className="settings-card"><div className="settings-head"><span className="settings-icon"><ShieldCheck /></span><div><strong>Upload-Post · respaldo #3</strong><p>Tercer publisher automático: solo entra cuando Metricool y Buffer no pudieron cubrir una red.</p></div><span className="state neutral">Fallback</span></div></article>
          <article className="settings-card">
            <div className="settings-head">
              <span className="settings-icon"><Wifi /></span>
              <div><strong>Nivel 4 · APIs directas</strong><p>Último respaldo: si Metricool, Buffer y Upload-Post fallan, publicamos directamente en la red autorizada.</p></div>
              <span className={`state ${socialStatus?.networks?.length && socialStatus.networks.every(item => item.connected) ? 'success' : 'warning'}`}>{socialStatus?.networks?.length && socialStatus.networks.every(item => item.connected) ? 'Listo' : 'Configurar'}</span>
            </div>
            {(socialStatus?.networks || []).map(item => (
              <div className="notice compact" key={item.network}>
                <div className="settings-head">
                  <span className="settings-icon">{item.connected ? <Wifi /> : <WifiOff />}</span>
                  <div>
                    <strong>{publicationNetworkLabels[item.network] || item.network}</strong>
                    <p>{item.connected ? `Autorizado${item.accountLabel ? ` · ${item.accountLabel}` : ''}` : item.configured ? 'Credenciales listas · falta autorizar la cuenta' : `Faltan: ${item.missing.join(', ')}`}{item.review === 'audit_required_for_public_posts' ? ' · falta auditoría para publicación pública' : item.review === 'explicit_consent_required_per_post' ? ' · publicación directa requiere confirmación por Reel' : item.review ? ' · requiere revisión del proveedor' : ''}</p>
                  </div>
                  <span className={`state ${item.connected ? 'success' : item.configured ? 'warning' : 'danger'}`}>{item.connected ? 'Conectado' : item.configured ? 'Autorizar' : 'Credenciales'}</span>
                </div>
                <button className="secondary full" disabled={socialBusy !== null || !item.configured} onClick={() => void (item.connected ? disconnectNative(item.network) : connectNative(item.network))}>
                  {socialBusy === item.network ? <Loader2 className="spin" size={17} /> : item.connected ? <WifiOff size={17} /> : <Wifi size={17} />}
                  {socialBusy === item.network ? 'Procesando…' : item.connected ? 'Desconectar' : 'Conectar cuenta'}
                </button>
              </div>
            ))}
            {!socialStatus?.networks?.length && <div className="notice compact">Validando las credenciales del Nivel 3…</div>}
            {socialMessage && <div className="notice compact">{socialMessage}</div>}
            <div className="notice compact">Callback OAuth: {window.location.origin}{window.location.pathname}</div>
          </article>

          <article className="settings-card"><div className="settings-head"><span className="settings-icon"><Activity /></span><div><strong>Autopiloto</strong><p>08:00 🇦🇷 Argentina · 13:00 🌎 Random · 20:30 🇦🇷 Argentina.</p></div><span className={`state ${automation?.enabled && automation?.ready ? 'success' : 'neutral'}`}>{automation?.enabled && automation?.ready ? 'Activo' : 'Pausado'}</span></div><button className="secondary full" disabled={!automation?.ready || metricoolBusy} onClick={() => void toggleAutomation()}>{automation?.enabled ? <Pause size={17} /> : <Power size={17} />}{automation?.enabled ? 'Pausar autopiloto' : 'Activar autopiloto'}</button></article>

          <article className="settings-card"><div className="settings-head"><span className="settings-icon">{worker?.online ? <Wifi /> : <WifiOff />}</span><div><strong>Estado del sistema</strong><p>{worker?.online ? 'Generador online' : 'Generador temporalmente sin conexión'} · {metricoolContingency?.ready ? 'Metricool principal listo' : 'Metricool requiere atención'} · {bufferStatus?.ready ? 'Buffer respaldo listo' : 'Buffer respaldo pendiente'}</p></div><span className={`state ${worker?.online && (metricoolContingency?.ready || bufferStatus?.ready) ? 'success' : 'danger'}`}>{worker?.online && (metricoolContingency?.ready || bufferStatus?.ready) ? 'Online' : 'Revisar'}</span></div>{automation?.lastError && <div className="error-detail">{automation.lastError}</div>}<button className="secondary full" onClick={() => { void refreshAll(); void loadBufferStatus(); void loadMetricoolContingency(); }}><RefreshCw size={17} /> Actualizar estado</button></article>

          {!isStandalone && <article className="settings-card"><div className="settings-head"><span className="settings-icon"><Download /></span><div><strong>Instalar aplicación</strong><p>Acceso directo desde el celular.</p></div></div><button className="secondary full" onClick={() => void installApp()}><Download size={17} /> Instalar</button></article>}
        </section>
      )}

      <footer className="legal-footer"><span>¿Cómo Así? Studio</span><a href="./privacy.html" target="_blank" rel="noreferrer">Privacidad</a><a href="./terms.html" target="_blank" rel="noreferrer">Términos</a></footer>
      <nav className="bottom-nav" aria-label="Navegación principal">{nav.map(({ name, label, icon: Icon }) => <button key={name} className={section === name ? 'active' : ''} onClick={() => { setSection(name); setNotice(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Icon size={21} /><span>{label}</span></button>)}</nav>

      {publishReel && <div className="sheet-backdrop" onClick={() => !scheduling && setPublishReel(null)}><section className="sheet" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}><button className="sheet-close" aria-label="Cerrar" onClick={() => setPublishReel(null)}><X /></button><span className="kicker">TRES REDES · UNA FECHA</span><h2>Programar Reel</h2><p className="sheet-title">{publishReel.title || publishReel.topic}</p><div className="network-row large"><span>Instagram ✓</span><span>TikTok ✓</span><span>YouTube ✓</span></div><label>Fecha y hora<input type="datetime-local" value={scheduledAt} min={scheduleDefault()} onChange={event => setScheduledAt(event.target.value)} /></label><button className="primary" disabled={scheduling} onClick={() => void scheduleReel()}>{scheduling ? <Loader2 className="spin" size={18} /> : <Send size={18} />}{scheduling ? 'Programando…' : 'Programar en las 3 redes'}</button></section></div>}
      {success && <div className="toast"><strong>Listo</strong><span>{success}</span></div>}
    </main>
  );
}

export default App;
