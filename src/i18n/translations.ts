/**
 * Localised strings. Keys are stable; values are en/fa.
 * Switching language in the settings updates the document <html lang/dir> for proper RTL.
 */
import type { Language } from '../store/settings';

export type TranslationKey =
  | 'welcomeTitle'
  | 'welcomeDesc'
  | 'startGame'
  | 'settings'
  | 'about'
  | 'credits'
  | 'exit'
  | 'selectMode'
  | 'singlePlayer'
  | 'lanGame'
  | 'serverGame'
  | 'createGame'
  | 'joinGame'
  | 'cancel'
  | 'connect'
  | 'start'
  | 'startTimer'
  | 'enterIp'
  | 'lanGames'
  | 'manualConnect'
  | 'searching'
  | 'noGames'
  | 'searchFailed'
  | 'hostLan'
  | 'joinLan'
  | 'lanHostNetwork'
  | 'lanJoinNetwork'
  | 'lanNetworkDesc'
  | 'hostInstructions'
  | 'joinInstructions'
  | 'copyCode'
  | 'copied'
  | 'pasteOffer'
  | 'pasteAnswer'
  | 'generateAnswer'
  | 'startHost'
  | 'waitingForGuest'
  | 'connected'
  | 'connecting'
  | 'disconnect'
  | 'resume'
  | 'exitToMenu'
  | 'paused'
  | 'spectating'
  | 'pressTab'
  | 'gameOver'
  | 'rank'
  | 'noRankings'
  | 'you'
  | 'player'
  | 'settingsGameSpeed'
  | 'settingsVolume'
  | 'settingsLanguage'
  | 'settingsGraphics'
  | 'settingsPointerLock'
  | 'settingsShowFps'
  | 'settingsCameraSens'
  | 'settingsIslandDamage'
  | 'settingsIslandSize'
  | 'islandSmall'
  | 'islandMedium'
  | 'islandLarge'
  | 'reset'
  | 'low'
  | 'medium'
  | 'high'
  | 'jump'
  | 'back'
  | 'aboutBody'
  | 'creditsBody'
  | 'score'
  | 'health'
  | 'fps'
  | 'latency'
  | 'players'
  | 'lanNoSignaling'
  | 'lanHostStep1'
  | 'lanHostStep2'
  | 'lanHostStep3'
  | 'lanJoinStep1'
  | 'lanJoinStep2'
  | 'lanJoinStep3'
  | 'lanConnectedAsHost'
  | 'lanConnectedAsGuest'
  | 'lanShareInvite'
  | 'lanPasteInvite'
  | 'lanPasteAnswer'
  | 'lanSendAnswer'
  | 'lanInvitePlaceholder'
  | 'lanAnswerPlaceholder'
  | 'lanWaitingForHost'
  | 'startGameConfirm'
  | 'win'
  | 'lostConnection'
  | 'controlsHint'
  | 'controlsHintMobile'
  | 'mobileNotice'
  | 'applySettings'
  | 'speedSlow'
  | 'speedNormal'
  | 'speedFast'
  | 'scanQr'
  | 'lobby'
  | 'lobbyTitle'
  | 'lobbyWaitingHost'
  | 'lobbyPlayers'
  | 'lobbyInviteMore'
  | 'lobbyInviteMoreShort'
  | 'lobbyStartGame'
  | 'lobbyStartHint'
  | 'lobbyNeedPlayers'
  | 'lobbyConnecting'
  | 'lobbyYou'
  | 'lobbyHost'
  | 'lobbyGuest'
  | 'lobbyWaitingGuests'
  | 'scanInvite'
  | 'scanAnswer'
  | 'scanClose'
  | 'scanHint'
  | 'regenerateInvite'
  | 'addPlayer';

type Dict = Record<TranslationKey, string>;

const en: Dict = {
  welcomeTitle: 'Welcome to Bounce Royale',
  welcomeDesc: 'Bounce, survive, and become the last one standing on a crumbling hex grid.',
  startGame: 'Start Game',
  settings: 'Settings',
  about: 'About',
  credits: 'Credits',
  exit: 'Exit',
  selectMode: 'Select Game Mode',
  singlePlayer: 'Single Player',
  lanGame: 'LAN Multiplayer (P2P)',
  serverGame: 'Online Server',
  createGame: 'Create Game',
  joinGame: 'Join Game',
  cancel: 'Cancel',
  connect: 'Connect',
  start: 'Start',
  startTimer: 'Start Timer (seconds, 5–60)',
  enterIp: 'Enter IP (e.g. 192.168.1.10:8443)',
  lanGames: 'LAN Games',
  manualConnect: 'Manual Connect',
  searching: 'Searching…',
  noGames: 'No games found. Try manual connect.',
  searchFailed: 'Failed to search for games. Try manual connect.',
  hostLan: 'LAN Multiplayer',
  joinLan: 'LAN Multiplayer',
  lanHostNetwork: 'Host Game',
  lanJoinNetwork: 'Join Game',
  lanNetworkDesc: 'cross-device, copy/paste codes',
  hostInstructions: 'Share your invite code with a friend on the same network.',
  joinInstructions: 'Paste the invite code from the host to connect.',
  copyCode: 'Copy Code',
  copied: 'Copied!',
  pasteOffer: 'Paste host invite code here',
  pasteAnswer: 'Paste guest answer code here',
  generateAnswer: 'Generate Answer',
  startHost: 'Start Hosting',
  waitingForGuest: 'Waiting for guest to connect…',
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnect: 'Disconnect',
  resume: 'Resume',
  exitToMenu: 'Exit to Menu',
  paused: 'Game Paused',
  spectating: 'Spectating',
  pressTab: 'Press TAB to switch players',
  gameOver: 'Game Over',
  rank: 'Rank',
  noRankings: 'No rankings available',
  you: 'You',
  player: 'Player',
  settingsGameSpeed: 'Game Speed',
  settingsVolume: 'Master Volume',
  settingsLanguage: 'Language',
  settingsGraphics: 'Graphics Quality',
  settingsPointerLock: 'Pointer Lock (Mouse)',
  settingsShowFps: 'Show FPS / Ping',
  settingsCameraSens: 'Camera Sensitivity',
  settingsIslandDamage: 'Island Damage',
  settingsIslandSize: 'Island Size',
  islandSmall: 'Small',
  islandMedium: 'Medium',
  islandLarge: 'Large',
  reset: 'Reset to Defaults',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  jump: 'Jump',
  back: 'Back',
  aboutBody:
    'Bounce Royale is a 3D physics battle royale built with Three.js and Rapier physics. Push your friends off a hex grid that crumbles under your feet. Last one bouncing wins.',
  creditsBody:
    'Original concept & code: Bounce Royale project. React rewrite with LAN P2P (WebRTC), FPS-independent physics and modular settings. Built with Three.js, Rapier, Vite and TypeScript.',
  score: 'Score',
  health: 'Health',
  fps: 'FPS',
  latency: 'Ping',
  players: 'Players',
  lanNoSignaling:
    'Pure peer-to-peer — no server required. Codes are compressed so they fit easily in a QR code.',
  lanHostStep1: '1. Click "Start Hosting" — your invite code & QR appear instantly.',
  lanHostStep2: '2. Share it with a friend (QR scan or copy the text).',
  lanHostStep3: '3. Paste the answer code they send back, then click "Connect".',
  lanJoinStep1: '1. Get the invite code from the host (scan their QR or copy).',
  lanJoinStep2: '2. Paste it below and click "Generate Answer".',
  lanJoinStep3: '3. Send your answer code back to the host. You connect once they paste it.',
  lanShareInvite: 'Share this invite code (QR or text)',
  lanPasteInvite: 'Paste host invite code',
  lanPasteAnswer: 'Paste guest answer code',
  lanSendAnswer: 'Send this answer code to the host',
  lanInvitePlaceholder: 'Paste the host code here…',
  lanAnswerPlaceholder: 'Paste the answer code from your friend here…',
  lanWaitingForHost: 'Waiting for host to apply your answer…',
  lanConnectedAsHost: 'Connected as host. Waiting for game to start…',
  lanConnectedAsGuest: 'Connected to host. Waiting for game to start…',
  startGameConfirm: 'Start Game',
  win: 'WINNER',
  lostConnection: 'Lost connection to peer.',
  controlsHint: 'WASD = move   ·   Space = jump   ·   Mouse = camera   ·   Esc = pause',
  controlsHintMobile: 'Left stick = move   ·   Right stick = camera   ·   Button = jump',
  mobileNotice: 'Tip: tap and drag to rotate camera.',
  applySettings: 'Settings apply instantly.',
  speedSlow: 'Slow',
  speedNormal: 'Normal',
  speedFast: 'Fast',
  scanQr: 'Scan QR',
  lobby: 'Lobby',
  lobbyTitle: '🎮 Game Lobby',
  lobbyWaitingHost: 'Waiting for the host to start the game…',
  lobbyPlayers: 'Players in lobby',
  lobbyInviteMore: 'Invite another player',
  lobbyInviteMoreShort: 'Invite more',
  lobbyStartGame: 'Start Game',
  lobbyStartHint: 'Click to begin the countdown and start the match.',
  lobbyNeedPlayers: 'At least 2 players are needed (you + 1 guest).',
  lobbyConnecting: 'Connecting…',
  lobbyYou: 'You',
  lobbyHost: 'Host',
  lobbyGuest: 'Guest',
  lobbyWaitingGuests: 'Share your code and wait for guests to join.',
  scanInvite: 'Scan invite code',
  scanAnswer: 'Scan answer code',
  scanClose: 'Close scanner',
  scanHint: 'Point the camera at the QR code',
  regenerateInvite: 'Regenerate invite code',
  addPlayer: 'Add another player',
};

const fa: Dict = {
  welcomeTitle: 'به بونس رویال خوش آمدید',
  welcomeDesc: 'بپر، زنده بمون و آخرین نفر روی صفحه شش‌ضلعی باقی بمون.',
  startGame: 'شروع بازی',
  settings: 'تنظیمات',
  about: 'درباره بازی',
  credits: 'سازندگان',
  exit: 'خروج',
  selectMode: 'انتخاب حالت بازی',
  singlePlayer: 'تک‌نفره',
  lanGame: 'بازی شبکه محلی (P2P)',
  serverGame: 'سرور آنلاین',
  createGame: 'ایجاد بازی',
  joinGame: 'پیوستن به بازی',
  cancel: 'لغو',
  connect: 'اتصال',
  start: 'شروع',
  startTimer: 'تایمر شروع (ثانیه، ۵–۶۰)',
  enterIp: 'آی‌پی را وارد کنید (مثال: 192.168.1.10:8443)',
  lanGames: 'بازی‌های شبکه محلی',
  manualConnect: 'اتصال دستی',
  searching: 'در حال جستجو…',
  noGames: 'بازی‌ای یافت نشد. اتصال دستی را امتحان کنید.',
  searchFailed: 'خطا در جستجو. اتصال دستی را امتحان کنید.',
  hostLan: 'بازی شبکه محلی',
  joinLan: 'بازی شبکه محلی',
  lanHostNetwork: 'میزبان بازی',
  lanJoinNetwork: 'پیوستن به بازی',
  lanNetworkDesc: 'دستگاه متفاوت، کپی/جای‌گذاری کد',
  hostInstructions: 'کد دعوت خود را با دوستتان در همان شبکه به اشتراک بگذارید.',
  joinInstructions: 'کد دعوت میزبان را جای‌گذاری کنید تا متصل شوید.',
  copyCode: 'کپی کد',
  copied: 'کپی شد!',
  pasteOffer: 'کد دعوت میزبان را اینجا جای‌گذاری کنید',
  pasteAnswer: 'کد پاسخ مهمان را اینجا جای‌گذاری کنید',
  generateAnswer: 'تولید پاسخ',
  startHost: 'شروع میزبانی',
  waitingForGuest: 'در انتظار اتصال مهمان…',
  connected: 'متصل',
  connecting: 'در حال اتصال…',
  disconnect: 'قطع اتصال',
  resume: 'ادامه',
  exitToMenu: 'خروج به منو',
  paused: 'بازی متوقف شد',
  spectating: 'حالت تماشا',
  pressTab: 'برای تعویض بازیکن، TAB را بزنید',
  gameOver: 'بازی تمام شد',
  rank: 'رتبه',
  noRankings: 'رتبه‌بندی در دسترس نیست',
  you: 'شما',
  player: 'بازیکن',
  settingsGameSpeed: 'سرعت بازی',
  settingsVolume: 'صدای کلی',
  settingsLanguage: 'زبان',
  settingsGraphics: 'کیفیت گرافیک',
  settingsPointerLock: 'قفل نشانگر ماوس',
  settingsShowFps: 'نمایش FPS / پینگ',
  settingsCameraSens: 'حساسیت دوربین',
  settingsIslandDamage: ' آسیب به جزیره',
  settingsIslandSize: 'اندازه جزیره',
  islandSmall: 'کوچک',
  islandMedium: 'متوسط',
  islandLarge: 'بزرگ',
  reset: 'بازنشانی به پیش‌فرض',
  low: 'پایین',
  medium: 'متوسط',
  high: 'بالا',
  jump: 'پرش',
  back: 'بازگشت',
  aboutBody:
    'بونس رویال یک بازی بتل رویال سه‌بعدی فیزیک‌محور است که با Three.js و موتور فیزیک Rapier ساخته شده. رقبای خود را از روی صفحه شش‌ضلعی که زیر پایتان فرو می‌ریزد هل دهید. آخرین بازیکن برنده است.',
  creditsBody:
    'ایده و کد اصلی: پروژه بونس رویال. بازنویسی React با قابلیت LAN نقطه‌به‌نقطه (WebRTC)، فیزیک مستقل از نرخ فریم و تنظیمات ماژولار. ساخته‌شده با Three.js، Rapier، Vite و TypeScript.',
  score: 'امتیاز',
  health: 'سلامت',
  fps: 'FPS',
  latency: 'پینگ',
  players: 'بازیکنان',
  lanNoSignaling:
    'کاملاً نقطه‌به‌نقطه — بدون نیاز به سرور. کدها فشرده می‌شوند تا به‌راحتی در QR جا بگیرند.',
  lanHostStep1: '۱. روی «شروع میزبانی» بزنید تا کد دعوت و QR فوراً ساخته شود.',
  lanHostStep2: '۲. آن را برای دوستتان بفرستید (اسکن QR یا کپی متن).',
  lanHostStep3: '۳. کد پاسخ او را جای‌گذاری کرده و «اتصال» را بزنید.',
  lanJoinStep1: '۱. کد دعوت را از میزبان بگیرید (QR او را اسکن کنید یا کپی کنید).',
  lanJoinStep2: '۲. آن را در پایین جای‌گذاری کنید و روی «تولید پاسخ» بزنید.',
  lanJoinStep3: '۳. کد پاسخ خود را برای میزبان بفرستید. پس از جای‌گذاری توسط میزبان متصل می‌شوید.',
  lanShareInvite: 'این کد دعوت را به اشتراک بگذارید (QR یا متن)',
  lanPasteInvite: 'کد دعوت میزبان را جای‌گذاری کنید',
  lanPasteAnswer: 'کد پاسخ مهمان را جای‌گذاری کنید',
  lanSendAnswer: 'این کد پاسخ را برای میزبان بفرستید',
  lanInvitePlaceholder: 'کد میزبان را اینجا جای‌گذاری کنید…',
  lanAnswerPlaceholder: 'کد پاسخ دوستتان را اینجا جای‌گذاری کنید…',
  lanWaitingForHost: 'در انتظار اعمال پاسخ توسط میزبان…',
  lanConnectedAsHost: 'به‌عنوان میزبان متصل شدید. در انتظار شروع بازی…',
  lanConnectedAsGuest: 'به میزبان متصل شدید. در انتظار شروع بازی…',
  startGameConfirm: 'شروع بازی',
  win: 'برنده',
  lostConnection: 'ارتباط با همتا قطع شد.',
  controlsHint: 'WASD = حرکت   ·   Space = پرش   ·   ماوس = دوربین   ·   Esc = توقف',
  controlsHintMobile: 'اهرم چپ = حرکت   ·   اهرم راست = دوربین   ·   دکمه = پرش',
  mobileNotice: 'نکته: برای چرخاندن دوربین، لمس و کشیدن انجام دهید.',
  applySettings: 'تغییرات بلافاصله اعمال می‌شوند.',
  speedSlow: 'آهسته',
  speedNormal: 'عادی',
  speedFast: 'سریع',
  scanQr: 'اسکن QR',
  lobby: 'لابی',
  lobbyTitle: '🎮 لابی بازی',
  lobbyWaitingHost: 'در انتظار شروع بازی توسط میزبان…',
  lobbyPlayers: 'بازیکنان حاضر در لابی',
  lobbyInviteMore: 'دعوت از بازیکن دیگر',
  lobbyInviteMoreShort: 'دعوت بیشتر',
  lobbyStartGame: 'شروع بازی',
  lobbyStartHint: 'برای شروع تایمر و آغاز مسابقه کلیک کنید.',
  lobbyNeedPlayers: 'حداقل ۲ بازیکن لازم است (شما + ۱ مهمان).',
  lobbyConnecting: 'در حال اتصال…',
  lobbyYou: 'شما',
  lobbyHost: 'میزبان',
  lobbyGuest: 'مهمان',
  lobbyWaitingGuests: 'کد خود را به اشتراک بگذارید و منتظر joining مهمان‌ها بمانید.',
  scanInvite: 'اسکن کد دعوت',
  scanAnswer: 'اسکن کد پاسخ',
  scanClose: 'بستن اسکنر',
  scanHint: 'دوربین را روی QR کد بگیرید',
  regenerateInvite: 'تولید مجدد کد دعوت',
  addPlayer: 'افزودن بازیکن دیگر',
};

const dicts: Record<Language, Dict> = { en, fa };

export function t(key: TranslationKey, lang: Language = 'en'): string {
  return dicts[lang]?.[key] ?? en[key] ?? key;
}

export function applyHtmlLang(lang: Language) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  document.body.classList.toggle('rtl', lang === 'fa');
}
