// locales/overlays.js — regional overlay entries
//
// Two kinds of content:
//  A. **Derivable**: Traditional character forms (Simplified -> Traditional), British spelling
//     (-ize -> -ise, color -> colour, ...).
//     These do not rely on hand translation - i18n.jsx derives them at runtime from the two base
//     dictionaries zh and en, so they are **complete coverage** and can never be missing a key.
//  B. **Not derivable**: Japanese, Korean, Spanish, Portuguese, French, German, Italian, Russian,
//     Arabic.
//     These genuinely have to be translated. Below are each language's **core UI entries**
//     (tabs, common actions, states); the remaining keys fall back to English along the chain -
//     showing English is preferable to showing machine-translation garbage.
//     Bulk completion goes through tools/i18n-translate.mjs (with your own LLM key, reviewable
//     entry by entry).

/** British spelling: whole-word replacement, never a substring (meter must not turn parameter into parametre) */
export const GB_SPELL = [
  ['color', 'colour'],
  ['colors', 'colours'],
  ['Color', 'Colour'],
  ['center', 'centre'],
  ['Center', 'Centre'],
  ['catalog', 'catalogue'],
  ['behavior', 'behaviour'],
  ['favorite', 'favourite'],
  ['favorites', 'favourites'],
  ['license', 'licence'],
  ['defense', 'defence'],
  ['gray', 'grey'],
  ['aluminum', 'aluminium'],
  ['check', 'check'], // keep it: check is also common in British English
];

/** Verb stems with a clear inflectional spelling difference (the organize -> organise family) */
export const GB_STEMS = [
  'organiz', 'recogniz', 'optimiz', 'normaliz', 'serializ', 'summariz', 'localiz',
  'customiz', 'synchroniz', 'categoriz', 'initializ', 'specializ', 'standardiz',
  'minimiz', 'maximiz', 'realiz', 'utiliz', 'memoriz', 'visualiz', 'finaliz',
  'apologiz', 'prioritiz', 'analyz',
];

/**
 * UI elements added later (new tabs, new panels) get their own small table.
 *
 * Why it is done this way: features keep getting added, and every new tab used to mean going back
 * and editing ten language blocks, which is guaranteed to miss one (the Arabic UI leaked the
 * English People / Calendar).
 * The merge runs at the **end** of this file - it has to sit after the HAND_COMMON declaration,
 * otherwise it hits the TDZ (`Cannot access 'HAND_COMMON' before initialization`, caught by the
 * self-check on the spot).
 *
 * The share entries here are the sharing page's second batch: the three stage headers, the check and
 * configure buttons, the image setting, and the manual hand-off. They are hand-written rather than left
 * to the machine layer for a measurable reason: the proofreading ratchet counts a locale's **own**
 * entries, so eighteen new keys left to the English fallback would have pushed every locale's suspect
 * count up by eighteen at once (measured: 307 -> 664) and the ratchet would have been "fixed" the wrong
 * way, by raising the baseline.
 */
const LATE_KEYS = {
  "ja-JP": {
    tab_people: "ピープル",
    tab_calendar: "カレンダー",
    sourceRegion: "地域",
    loginCheckTitle: "ここではブラウザのログイン状態を読み取り専用で読み取ります（開いたままでも、ロックも変更もしません）",
    openInEditor: "エディターで開く",
    openInEditorFailed: "開けませんでした",
    openEditorTitle: "開き方",
    openEditorHint: "空欄ならこのマシンで設定されたエディターを使い、無ければ OS 既定の方法で開きます。ここに入れるのは「プログラム名 + 引数」で、シェルは経由しません。要求には種類とファイル名だけを載せ、パスはサーバーが自分の出力ディレクトリ内で解決します。",
    shareTextEdited: "現在はあなたが編集した本文です（このサイト専用）",
    shareTextPrepared: "現在は本アプリが用意した本文です（このサイトの上限に合わせて切断済み）",
    shareTextReset: "用意した本文に戻す",
    shareTextPrepare: "用意した本文を作り直す",
    cookieDomain: "読むのは {domain} のログイン状態",
    noProfileDir: "先に「設定 → ブラウザー」でユーザーデータディレクトリを設定してください（未設定だとログイン状態を読めません）",
    loginNotCheckable: "このソースはログイン不要と宣言しているため、確認できるログイン状態がありません",
    loginNoHost: "この対象には読み取れるドメインがないため、ログイン状態を確認できません",
    loginFieldsEmpty: "ログイン状態を確認するにはユーザー名と BotPassword を入力してください",
    loginNoDiscovery: "この種類のアカウントを見つける手段がありません（見つけられるログインは一種類だけです）。不足しているものをそのまま報告します",
    shareAccountPick: "使うアカウント",
    shareCheck: "必要な状態を確認",
    shareConfig: "設定",
    shareImages: "画像",
    shareImagesCount: "1ファイルあたりの最大枚数",
    shareManual: "手動投稿",
    shareManualCopy: "本文をコピー",
    shareManualDownload: "ファイルを保存",
    shareManualFull: "本文がこのサイトの上限を超えているため、ボタンに本文は入りません（コピーか保存を使ってください）",
    shareManualHint: "このサイトには自動投稿できません。本文と画像を用意するので、コピーするか投稿ページを開いて自分で投稿してください。",
    shareManualOpen: "投稿ページを開く",
    shareSiteAdd: "サイトを追加",
    shareSiteCancel: "キャンセル",
    shareSiteId: "サイト id",
    shareSiteLink: "投稿ページ",
    shareSiteLoginKind: "ログイン方式",
    shareSiteName: "名前",
    shareSiteNeeds: "検出された必要条件",
    shareSitePh: "例: my-site（英数字・-・_）",
    shareSiteRemove: "サイトを削除",
    shareSiteSave: "追加",
    shareStageAccount: "アカウント",
    shareStageSend: "送信",
    shareStageVerify: "確認",
    shareTextLimit: "このサイトの上限は {n} 文字",
  },
  "ko-KR": {
    tab_people: "관심",
    tab_calendar: "달력",
    sourceRegion: "지역",
    loginCheckTitle: "여기서는 브라우저의 로그인 상태를 읽기 전용으로 읽습니다(브라우저가 켜져 있어도 잠그거나 바꾸지 않습니다)",
    openInEditor: "편집기에서 열기",
    openInEditorFailed: "열지 못했습니다",
    openEditorTitle: "여는 방법",
    openEditorHint: "비워 두면 이 컴퓨터에 설정된 편집기를 사용하고, 없으면 운영체제 기본 방식으로 엽니다. 여기에 넣는 값은 \"프로그램 이름 + 인수\"이며 셸을 거치지 않습니다. 요청에는 종류와 파일 이름만 담기고 경로는 서버가 자기 출력 디렉터리 안에서 해석합니다.",
    shareTextEdited: "지금은 직접 수정한 본문입니다(이 사이트 전용)",
    shareTextPrepared: "지금은 이 앱이 준비한 본문입니다(이 사이트 한도에 맞게 잘림)",
    shareTextReset: "준비된 본문으로 되돌리기",
    shareTextPrepare: "준비된 본문 다시 만들기",
    cookieDomain: "{domain}의 로그인 상태를 읽습니다",
    noProfileDir: "먼저 설정 → 브라우저에서 사용자 데이터 디렉터리를 지정하세요. 지정하지 않으면 로그인 상태를 읽을 수 없습니다",
    loginNotCheckable: "이 소스는 로그인이 필요 없다고 선언했으므로 확인할 로그인 상태가 없습니다",
    loginNoHost: "이 대상에는 읽을 도메인이 없어 로그인 상태를 확인할 수 없습니다",
    loginFieldsEmpty: "로그인 상태를 확인하려면 사용자 이름과 BotPassword를 입력하세요",
    loginNoDiscovery: "이 종류의 계정을 찾을 방법이 없습니다(찾을 수 있는 로그인은 한 종류뿐입니다). 부족한 것을 그대로 보고합니다",
    shareAccountPick: "사용할 계정",
    shareCheck: "필요한 상태 확인",
    shareConfig: "설정",
    shareImages: "이미지",
    shareImagesCount: "파일당 최대 장수",
    shareManual: "수동 게시",
    shareManualCopy: "본문 복사",
    shareManualDownload: "파일 내려받기",
    shareManualFull: "본문이 이 사이트의 제한을 넘어 버튼에 본문이 들어가지 않습니다 (복사나 내려받기를 사용하세요)",
    shareManualHint: "이 사이트에는 자동으로 게시할 수 없습니다. 본문과 이미지를 준비해 두니 복사하거나 작성 페이지를 열어 직접 게시하세요.",
    shareManualOpen: "작성 페이지 열기",
    shareSiteAdd: "사이트 추가",
    shareSiteCancel: "취소",
    shareSiteId: "사이트 id",
    shareSiteLink: "작성 페이지",
    shareSiteLoginKind: "로그인 방식",
    shareSiteName: "이름",
    shareSiteNeeds: "감지된 필요 조건",
    shareSitePh: "예: my-site (영문, 숫자, -, _)",
    shareSiteRemove: "사이트 삭제",
    shareSiteSave: "추가",
    shareStageAccount: "계정",
    shareStageSend: "전송",
    shareStageVerify: "확인",
    shareTextLimit: "이 사이트의 제한은 {n}자",
  },
  "th-TH": {
    tab_people: "คน",
    tab_calendar: "ปฏิทิน",
    sourceRegion: "ภูมิภาค",
    loginCheckTitle: "ที่นี่จะอ่านสถานะการเข้าสู่ระบบของเบราว์เซอร์แบบอ่านอย่างเดียว (เปิดอยู่ก็ได้ ไม่ล็อกและไม่แก้ไข)",
    openInEditor: "เปิดในโปรแกรมแก้ไข",
    openInEditorFailed: "เปิดไม่สำเร็จ",
    openEditorTitle: "วิธีเปิดไฟล์",
    openEditorHint: "เว้นว่างไว้จะใช้โปรแกรมแก้ไขที่ตั้งค่าไว้บนเครื่องนี้ ถ้าไม่มีจึงใช้วิธีเปิดเริ่มต้นของระบบ ค่าที่ใส่คือ \"ชื่อโปรแกรม + อาร์กิวเมนต์\" และไม่ผ่านเชลล์ คำขอส่งเพียงชนิดและชื่อไฟล์ ส่วนเส้นทางให้เซิร์ฟเวอร์หาเองในโฟลเดอร์ผลลัพธ์ของตน",
    shareTextEdited: "ตอนนี้เป็นข้อความที่คุณแก้เอง (แยกเฉพาะไซต์นี้)",
    shareTextPrepared: "ตอนนี้เป็นข้อความที่แอปเตรียมไว้ (ตัดตามขีดจำกัดของไซต์นี้แล้ว)",
    shareTextReset: "กลับไปใช้ข้อความที่เตรียมไว้",
    shareTextPrepare: "สร้างข้อความที่เตรียมไว้ใหม่",
    cookieDomain: "กำลังอ่านสถานะการเข้าสู่ระบบของ {domain}",
    noProfileDir: "ตั้งค่าโฟลเดอร์โปรไฟล์เบราว์เซอร์ใน ตั้งค่า → เบราว์เซอร์ ก่อน มิฉะนั้นจะอ่านสถานะการเข้าสู่ระบบไม่ได้",
    loginNotCheckable: "แหล่งนี้ระบุว่าไม่ต้องเข้าสู่ระบบ จึงไม่มีสถานะการเข้าสู่ระบบให้ตรวจ",
    loginNoHost: "เป้าหมายนี้ไม่มีโดเมนให้อ่าน จึงตรวจสอบสถานะการเข้าสู่ระบบไม่ได้",
    loginFieldsEmpty: "กรอกชื่อผู้ใช้และ BotPassword ก่อนจึงจะตรวจสอบการเข้าสู่ระบบได้",
    loginNoDiscovery: "ไม่มีวิธีค้นหาบัญชีประเภทนี้ (ค้นพบได้เพียงการเข้าสู่ระบบชนิดเดียว) จึงรายงานสิ่งที่ขาดตามจริง",
    shareAccountPick: "บัญชีที่จะใช้",
    shareCheck: "ตรวจสอบสิ่งที่ต้องมี",
    shareConfig: "ตั้งค่า",
    shareImages: "รูปภาพ",
    shareImagesCount: "จำนวนสูงสุดต่อไฟล์",
    shareManual: "โพสต์เอง",
    shareManualCopy: "คัดลอกเนื้อหา",
    shareManualDownload: "ดาวน์โหลดไฟล์",
    shareManualFull: "เนื้อหายาวเกินขีดจำกัดของไซต์นี้ ปุ่มจึงไม่ใส่เนื้อหา (ใช้คัดลอกหรือดาวน์โหลด)",
    shareManualHint: "ไซต์นี้โพสต์อัตโนมัติไม่ได้ ระบบเตรียมเนื้อหาและรูปไว้ให้แล้ว ให้คัดลอกหรือเปิดหน้าโพสต์แล้วโพสต์เอง",
    shareManualOpen: "เปิดหน้าโพสต์",
    shareSiteAdd: "เพิ่มไซต์",
    shareSiteCancel: "ยกเลิก",
    shareSiteId: "id ของไซต์",
    shareSiteLink: "หน้าโพสต์",
    shareSiteLoginKind: "วิธีเข้าสู่ระบบ",
    shareSiteName: "ชื่อ",
    shareSiteNeeds: "สิ่งที่ตรวจพบว่าต้องมี",
    shareSitePh: "เช่น my-site (ตัวอักษร ตัวเลข - และ _)",
    shareSiteRemove: "ลบไซต์",
    shareSiteSave: "เพิ่ม",
    shareStageAccount: "บัญชี",
    shareStageSend: "ส่ง",
    shareStageVerify: "ตรวจสอบ",
    shareTextLimit: "ไซต์นี้จำกัด {n} ตัวอักษร",
  },
  "id-ID": {
    tab_people: "Orang",
    tab_calendar: "Kalender",
    sourceRegion: "Wilayah",
    loginCheckTitle: "Di sini status login browser dibaca hanya-baca (boleh tetap terbuka, tidak dikunci atau diubah)",
    openInEditor: "Buka di editor",
    openInEditorFailed: "Gagal membuka",
    openEditorTitle: "Cara membuka",
    openEditorHint: "Kosongkan untuk memakai editor yang diatur di komputer ini, lalu cara bawaan sistem bila tidak ada. Isinya adalah \"nama program + argumen\" dan tidak lewat shell; permintaan hanya membawa jenis dan nama berkas, sedangkan lokasinya ditentukan server di dalam direktorinya sendiri.",
    shareTextEdited: "ini teks yang Anda sunting (khusus untuk situs ini)",
    shareTextPrepared: "ini teks yang disiapkan aplikasi (sudah dipotong sesuai batas situs ini)",
    shareTextReset: "kembali ke teks yang disiapkan",
    shareTextPrepare: "buat ulang teks yang disiapkan",
    cookieDomain: "membaca status login untuk {domain}",
    noProfileDir: "Tetapkan direktori profil browser di Pengaturan → Browser dulu, jika tidak status login tidak dapat dibaca",
    loginNotCheckable: "Sumber ini menyatakan tidak perlu login, jadi tidak ada status login yang bisa diperiksa",
    loginNoHost: "Target ini tidak punya domain yang bisa dibaca, jadi status loginnya tidak dapat diperiksa",
    loginFieldsEmpty: "Isi nama pengguna dan BotPassword sebelum memeriksa login",
    loginNoDiscovery: "tidak ada cara menemukan akun jenis ini (hanya satu jenis login yang bisa ditemukan), jadi yang dilaporkan adalah apa yang kurang",
    shareAccountPick: "Akun yang dipakai",
    shareCheck: "Periksa yang dibutuhkan",
    shareConfig: "Konfigurasi",
    shareImages: "Gambar",
    shareImagesCount: "Maksimum per berkas",
    shareManual: "Kirim manual",
    shareManualCopy: "Salin isi",
    shareManualDownload: "Unduh berkas",
    shareManualFull: "Isi melebihi batas situs ini, jadi tombol tidak membawa isi (pakai salin atau unduh)",
    shareManualHint: "Situs ini tidak bisa dikirim otomatis: isi dan gambar sudah disiapkan, salin atau buka halaman tulis lalu kirim sendiri.",
    shareManualOpen: "Buka halaman tulis",
    shareSiteAdd: "Tambah situs",
    shareSiteCancel: "Batal",
    shareSiteId: "id situs",
    shareSiteLink: "halaman tulis",
    shareSiteLoginKind: "Cara masuk",
    shareSiteName: "Nama",
    shareSiteNeeds: "kebutuhan yang terdeteksi",
    shareSitePh: "mis. my-site (huruf, angka, - dan _)",
    shareSiteRemove: "Hapus situs",
    shareSiteSave: "Tambah",
    shareStageAccount: "Akun",
    shareStageSend: "Kirim",
    shareStageVerify: "Verifikasi",
    shareTextLimit: "situs ini menerima {n} karakter",
  },
  "vi-VN": {
    tab_people: "Người",
    tab_calendar: "Lịch",
    sourceRegion: "Khu vực",
    loginCheckTitle: "Ở đây trạng thái đăng nhập của trình duyệt được đọc ở chế độ chỉ đọc (đang mở cũng được, không khóa và không sửa)",
    openInEditor: "Mở bằng trình soạn thảo",
    openInEditorFailed: "Không mở được",
    openEditorTitle: "Cách mở tệp",
    openEditorHint: "Để trống thì dùng trình soạn thảo đã đặt trên máy này, không có thì dùng cách mở mặc định của hệ thống. Giá trị ở đây là \"tên chương trình + tham số\" và không đi qua shell; yêu cầu chỉ mang loại và tên tệp, còn đường dẫn do máy chủ tự tìm trong thư mục đầu ra của nó.",
    shareTextEdited: "đây là nội dung bạn đã sửa (riêng cho trang này)",
    shareTextPrepared: "đây là nội dung do ứng dụng chuẩn bị (đã cắt theo giới hạn của trang này)",
    shareTextReset: "quay lại nội dung đã chuẩn bị",
    shareTextPrepare: "tạo lại nội dung đã chuẩn bị",
    cookieDomain: "đang đọc trạng thái đăng nhập của {domain}",
    noProfileDir: "Hãy đặt thư mục hồ sơ trình duyệt trong Cài đặt → Trình duyệt trước, nếu không sẽ không đọc được trạng thái đăng nhập",
    loginNotCheckable: "Nguồn này khai báo không cần đăng nhập nên không có trạng thái đăng nhập để kiểm tra",
    loginNoHost: "Mục tiêu này không có tên miền để đọc nên không kiểm tra được trạng thái đăng nhập",
    loginFieldsEmpty: "Hãy điền tên người dùng và BotPassword trước khi kiểm tra đăng nhập",
    loginNoDiscovery: "không có cách tìm tài khoản thuộc loại đó (chỉ tìm được một loại đăng nhập), nên nó báo đúng những gì còn thiếu",
    shareAccountPick: "Tài khoản dùng",
    shareCheck: "Kiểm tra yêu cầu",
    shareConfig: "Cấu hình",
    shareImages: "Hình ảnh",
    shareImagesCount: "Tối đa mỗi tệp",
    shareManual: "Đăng thủ công",
    shareManualCopy: "Sao chép nội dung",
    shareManualDownload: "Tải tệp",
    shareManualFull: "Nội dung vượt giới hạn của trang này nên nút không kèm nội dung (dùng sao chép hoặc tải tệp)",
    shareManualHint: "Trang này không thể đăng tự động: nội dung và ảnh đã được chuẩn bị, hãy sao chép hoặc mở trang đăng bài rồi tự đăng.",
    shareManualOpen: "Mở trang đăng bài",
    shareSiteAdd: "Thêm trang",
    shareSiteCancel: "Hủy",
    shareSiteId: "id trang",
    shareSiteLink: "trang đăng bài",
    shareSiteLoginKind: "Cách đăng nhập",
    shareSiteName: "Tên",
    shareSiteNeeds: "yêu cầu phát hiện được",
    shareSitePh: "ví dụ my-site (chữ, số, - và _)",
    shareSiteRemove: "Xóa trang",
    shareSiteSave: "Thêm",
    shareStageAccount: "Tài khoản",
    shareStageSend: "Gửi",
    shareStageVerify: "Xác minh",
    shareTextLimit: "trang này nhận {n} ký tự",
  },
  "es-ES": {
    tab_people: "Personas",
    tab_calendar: "Calendario",
    sourceRegion: "Región",
    loginCheckTitle: "Aquí se lee el estado de sesión del navegador solo en modo lectura (puede estar abierto; no se bloquea ni se modifica)",
    openInEditor: "Abrir en el editor",
    openInEditorFailed: "No se pudo abrir",
    openEditorTitle: "Cómo abrir",
    openEditorHint: "Déjalo vacío para usar el editor configurado en esta máquina y, si no hay, el modo predeterminado del sistema. El valor es \"programa + argumentos\" y nunca pasa por un shell; la petición solo lleva el tipo y el nombre del archivo, y la ruta la resuelve el servidor dentro de sus propios directorios.",
    shareTextEdited: "este es el texto que has editado (una copia propia de este sitio)",
    shareTextPrepared: "este es el texto preparado por la aplicación (ya recortado al límite de este sitio)",
    shareTextReset: "volver al texto preparado",
    shareTextPrepare: "regenerar el texto preparado",
    cookieDomain: "leyendo el estado de sesión de {domain}",
    noProfileDir: "Configura primero el directorio de datos del navegador en Ajustes → Navegador; si no, no se puede leer el estado de sesión",
    loginNotCheckable: "Esta fuente declara que no necesita inicio de sesión, así que no hay estado de sesión que comprobar",
    loginNoHost: "Este destino no tiene un dominio que leer, así que no se puede comprobar su estado de sesión",
    loginFieldsEmpty: "Rellena el usuario y la BotPassword antes de comprobar el inicio de sesión",
    loginNoDiscovery: "no hay forma de buscar una sesión de este tipo (solo se encuentra un tipo de inicio de sesión), así que informa de lo que falta",
    shareAccountPick: "Cuenta a usar",
    shareCheck: "Comprobar lo necesario",
    shareConfig: "Configurar",
    shareImages: "Imágenes",
    shareImagesCount: "Máximo por archivo",
    shareManual: "Publicación manual",
    shareManualCopy: "Copiar texto",
    shareManualDownload: "Descargar archivo",
    shareManualFull: "El texto supera el límite de este sitio, así que el botón no lleva texto (usa copiar o descargar)",
    shareManualHint: "Este sitio no admite publicación automática: el texto y las imágenes ya están preparados; cópialos o abre la página de publicación y publícalo tú.",
    shareManualOpen: "Abrir página de publicación",
    shareSiteAdd: "Añadir sitio",
    shareSiteCancel: "Cancelar",
    shareSiteId: "id del sitio",
    shareSiteLink: "página de publicación",
    shareSiteLoginKind: "Forma de acceso",
    shareSiteName: "Nombre",
    shareSiteNeeds: "requisitos detectados",
    shareSitePh: "p. ej. my-site (letras, dígitos, - y _)",
    shareSiteRemove: "Quitar sitio",
    shareSiteSave: "Añadir",
    shareStageAccount: "Cuenta",
    shareStageSend: "Enviar",
    shareStageVerify: "Verificar",
    shareTextLimit: "este sitio acepta {n} caracteres",
  },
  "es-419": {
    tab_people: "Personas",
    tab_calendar: "Calendario",
    sourceRegion: "Región",
    shareAccountPick: "Cuenta a usar",
    shareCheck: "Comprobar lo necesario",
    shareConfig: "Configurar",
    shareImages: "Imágenes",
    shareImagesCount: "Máximo por archivo",
    shareManual: "Publicación manual",
    shareManualCopy: "Copiar texto",
    shareManualDownload: "Descargar archivo",
    shareManualFull: "El texto supera el límite de este sitio, así que el botón no lleva texto (usa copiar o descargar)",
    shareManualHint: "Este sitio no admite publicación automática: el texto y las imágenes ya están preparados; cópialos o abre la página de publicación y publícalo tú.",
    shareManualOpen: "Abrir página de publicación",
    shareSiteAdd: "Agregar sitio",
    shareSiteCancel: "Cancelar",
    shareSiteId: "id del sitio",
    shareSiteLink: "página de publicación",
    shareSiteLoginKind: "Forma de acceso",
    shareSiteName: "Nombre",
    shareSiteNeeds: "requisitos detectados",
    shareSitePh: "p. ej. my-site (letras, dígitos, - y _)",
    shareSiteRemove: "Quitar sitio",
    shareSiteSave: "Agregar",
    shareStageAccount: "Cuenta",
    shareStageSend: "Enviar",
    shareStageVerify: "Verificar",
    shareTextLimit: "este sitio acepta {n} caracteres",
  },
  "pt-PT": {
    tab_people: "Pessoas",
    tab_calendar: "Calendário",
    sourceRegion: "Região",
    loginCheckTitle: "Aqui o estado de sessão do navegador é lido apenas em modo de leitura (pode estar aberto; não é bloqueado nem alterado)",
    openInEditor: "Abrir no editor",
    openInEditorFailed: "Não foi possível abrir",
    openEditorTitle: "Como abrir",
    openEditorHint: "Deixe vazio para usar o editor configurado nesta máquina e, se não existir, o modo predefinido do sistema. O valor é \"programa + argumentos\" e nunca passa por um shell; o pedido leva apenas o tipo e o nome do ficheiro, e o caminho é resolvido pelo servidor dentro das suas próprias pastas.",
    shareTextEdited: "este é o texto que editou (uma cópia própria deste site)",
    shareTextPrepared: "este é o texto preparado pela aplicação (já cortado ao limite deste site)",
    shareTextReset: "voltar ao texto preparado",
    shareTextPrepare: "gerar de novo o texto preparado",
    cookieDomain: "a ler o estado de sessão de {domain}",
    noProfileDir: "Defina primeiro a pasta de dados do navegador em Definições → Navegador; caso contrário, o estado de sessão não pode ser lido",
    loginNotCheckable: "Esta fonte declara que não precisa de sessão, por isso não há estado de sessão para verificar",
    loginNoHost: "Este destino não tem um domínio para ler, por isso o estado de sessão não pode ser verificado",
    loginFieldsEmpty: "Preencha o nome de utilizador e a BotPassword antes de verificar a sessão",
    loginNoDiscovery: "não há forma de encontrar uma sessão deste tipo (só se encontra um tipo de início de sessão), por isso reporta o que falta",
    shareAccountPick: "Conta a usar",
    shareCheck: "Verificar o que é preciso",
    shareConfig: "Configurar",
    shareImages: "Imagens",
    shareImagesCount: "Máximo por ficheiro",
    shareManual: "Publicação manual",
    shareManualCopy: "Copiar texto",
    shareManualDownload: "Descarregar ficheiro",
    shareManualFull: "O texto excede o limite deste site, por isso o botão não leva texto (use copiar ou descarregar)",
    shareManualHint: "Este site não aceita publicação automática: o texto e as imagens estão preparados; copie-os ou abra a página de publicação e publique você mesmo.",
    shareManualOpen: "Abrir página de publicação",
    shareSiteAdd: "Adicionar site",
    shareSiteCancel: "Cancelar",
    shareSiteId: "id do site",
    shareSiteLink: "página de publicação",
    shareSiteLoginKind: "Forma de início de sessão",
    shareSiteName: "Nome",
    shareSiteNeeds: "requisitos detetados",
    shareSitePh: "por exemplo my-site (letras, dígitos, - e _)",
    shareSiteRemove: "Remover site",
    shareSiteSave: "Adicionar",
    shareStageAccount: "Conta",
    shareStageSend: "Enviar",
    shareStageVerify: "Verificar",
    shareTextLimit: "este site aceita {n} caracteres",
  },
  "pt-BR": {
    tab_people: "Pessoas",
    tab_calendar: "Calendário",
    sourceRegion: "Região",
    loginCheckTitle: "Aqui o estado de login do navegador é lido somente para leitura (pode estar aberto; não é bloqueado nem alterado)",
    openInEditor: "Abrir no editor",
    openInEditorFailed: "Não foi possível abrir",
    openEditorTitle: "Como abrir",
    openEditorHint: "Deixe vazio para usar o editor configurado nesta máquina e, se não existir, o modo padrão do sistema. O valor é \"programa + argumentos\" e nunca passa por um shell; a requisição leva apenas o tipo e o nome do arquivo, e o caminho é resolvido pelo servidor dentro de suas próprias pastas.",
    shareTextEdited: "este é o texto que você editou (uma cópia própria deste site)",
    shareTextPrepared: "este é o texto preparado pelo aplicativo (já cortado no limite deste site)",
    shareTextReset: "voltar ao texto preparado",
    shareTextPrepare: "gerar novamente o texto preparado",
    cookieDomain: "lendo o estado de login de {domain}",
    noProfileDir: "Defina primeiro a pasta de dados do navegador em Configurações → Navegador; caso contrário, o estado de login não pode ser lido",
    loginNotCheckable: "Esta fonte declara que não precisa de login, então não há estado de login para verificar",
    loginNoHost: "Este destino não tem um domínio para ler, então o estado de login não pode ser verificado",
    loginFieldsEmpty: "Preencha o usuário e a BotPassword antes de verificar o login",
    loginNoDiscovery: "não há como encontrar um login desse tipo (só um tipo de login é encontrado), então relata o que está faltando",
    shareAccountPick: "Conta a usar",
    shareCheck: "Verificar o que é preciso",
    shareConfig: "Configurar",
    shareImages: "Imagens",
    shareImagesCount: "Máximo por arquivo",
    shareManual: "Publicação manual",
    shareManualCopy: "Copiar texto",
    shareManualDownload: "Baixar arquivo",
    shareManualFull: "O texto passa do limite deste site, então o botão não leva texto (use copiar ou baixar)",
    shareManualHint: "Este site não aceita publicação automática: o texto e as imagens estão prontos; copie ou abra a página de publicação e publique você mesmo.",
    shareManualOpen: "Abrir página de publicação",
    shareSiteAdd: "Adicionar site",
    shareSiteCancel: "Cancelar",
    shareSiteId: "id do site",
    shareSiteLink: "página de publicação",
    shareSiteLoginKind: "Forma de login",
    shareSiteName: "Nome",
    shareSiteNeeds: "requisitos detectados",
    shareSitePh: "por exemplo my-site (letras, dígitos, - e _)",
    shareSiteRemove: "Remover site",
    shareSiteSave: "Adicionar",
    shareStageAccount: "Conta",
    shareStageSend: "Enviar",
    shareStageVerify: "Verificar",
    shareTextLimit: "este site aceita {n} caracteres",
  },
  "fr-FR": {
    tab_people: "Personnes",
    tab_calendar: "Calendrier",
    sourceRegion: "Région",
    loginCheckTitle: "Ici, l’état de connexion du navigateur est lu en lecture seule (il peut rester ouvert ; rien n’est verrouillé ni modifié)",
    openInEditor: "Ouvrir dans l’éditeur",
    openInEditorFailed: "Impossible d’ouvrir",
    openEditorTitle: "Ouverture des fichiers",
    openEditorHint: "Laissez vide pour utiliser l’éditeur configuré sur cette machine, puis le mode par défaut du système. La valeur est « programme + arguments » et ne passe jamais par un shell ; la requête ne porte que le type et le nom du fichier, le chemin étant résolu par le serveur dans ses propres dossiers.",
    shareTextEdited: "c’est le texte que vous avez modifié (une copie propre à ce site)",
    shareTextPrepared: "c’est le texte préparé par l’application (déjà coupé à la limite de ce site)",
    shareTextReset: "revenir au texte préparé",
    shareTextPrepare: "régénérer le texte préparé",
    cookieDomain: "lecture de l’état de connexion de {domain}",
    noProfileDir: "Renseignez d’abord le dossier de données du navigateur dans Réglages → Navigateur, sinon l’état de connexion ne peut pas être lu",
    loginNotCheckable: "Cette source déclare ne pas avoir besoin de connexion : il n’y a donc aucun état de connexion à vérifier",
    loginNoHost: "Cette cible n’a pas de domaine à lire : son état de connexion ne peut pas être vérifié",
    loginFieldsEmpty: "Renseignez le nom d’utilisateur et le BotPassword avant de vérifier la connexion",
    loginNoDiscovery: "aucun moyen de rechercher une connexion de ce type (un seul type de connexion est trouvé), le manque est donc signalé tel quel",
    shareAccountPick: "Compte à utiliser",
    shareCheck: "Vérifier ce qui manque",
    shareConfig: "Configurer",
    shareImages: "Images",
    shareImagesCount: "Maximum par fichier",
    shareManual: "Publication manuelle",
    shareManualCopy: "Copier le texte",
    shareManualDownload: "Télécharger le fichier",
    shareManualFull: "Le texte dépasse la limite de ce site, donc le bouton ne porte pas le texte (utilisez copier ou télécharger)",
    shareManualHint: "Ce site n'accepte pas la publication automatique : le texte et les images sont préparés ; copiez-les ou ouvrez la page de publication et publiez vous-même.",
    shareManualOpen: "Ouvrir la page de publication",
    shareSiteAdd: "Ajouter un site",
    shareSiteCancel: "Annuler",
    shareSiteId: "id du site",
    shareSiteLink: "page de publication",
    shareSiteLoginKind: "Moyen de connexion",
    shareSiteName: "Nom",
    shareSiteNeeds: "exigences détectées",
    shareSitePh: "par ex. my-site (lettres, chiffres, - et _)",
    shareSiteRemove: "Supprimer le site",
    shareSiteSave: "Ajouter",
    shareStageAccount: "Compte",
    shareStageSend: "Envoyer",
    shareStageVerify: "Vérifier",
    shareTextLimit: "ce site accepte {n} caractères",
  },
  "de-DE": {
    tab_people: "Personen",
    tab_calendar: "Kalender",
    sourceRegion: "Region",
    loginCheckTitle: "Hier wird der Anmeldestatus des Browsers schreibgeschützt gelesen (er darf geöffnet bleiben; nichts wird gesperrt oder geändert)",
    openInEditor: "Im Editor öffnen",
    openInEditorFailed: "Konnte nicht geöffnet werden",
    openEditorTitle: "Dateien öffnen",
    openEditorHint: "Leer lassen, um den auf diesem Rechner eingestellten Editor zu verwenden und sonst die Standardmethode des Systems. Der Wert ist \"Programm + Argumente\" und läuft nie durch eine Shell; die Anfrage trägt nur Art und Dateiname, den Pfad löst der Server in seinen eigenen Ausgabeverzeichnissen auf.",
    shareTextEdited: "dies ist dein bearbeiteter Text (eine eigene Fassung für diese Seite)",
    shareTextPrepared: "dies ist der von der App vorbereitete Text (bereits auf das Limit dieser Seite gekürzt)",
    shareTextReset: "zurück zum vorbereiteten Text",
    shareTextPrepare: "vorbereiteten Text neu erzeugen",
    cookieDomain: "liest den Anmeldestatus von {domain}",
    noProfileDir: "Lege zuerst das Benutzerdatenverzeichnis des Browsers unter Einstellungen → Browser fest, sonst kann der Anmeldestatus nicht gelesen werden",
    loginNotCheckable: "Diese Quelle erklärt, dass keine Anmeldung nötig ist; es gibt also keinen Anmeldestatus zu prüfen",
    loginNoHost: "Dieses Ziel hat keine Domain zum Lesen; sein Anmeldestatus kann nicht geprüft werden",
    loginFieldsEmpty: "Trage Benutzername und BotPassword ein, bevor die Anmeldung geprüft wird",
    loginNoDiscovery: "es gibt keine Möglichkeit, eine Anmeldung dieser Art zu finden (nur eine Anmeldeart ist auffindbar), daher wird gemeldet, was fehlt",
    shareAccountPick: "Zu verwendendes Konto",
    shareCheck: "Fehlendes prüfen",
    shareConfig: "Konfigurieren",
    shareImages: "Bilder",
    shareImagesCount: "Höchstens pro Datei",
    shareManual: "Manuell veröffentlichen",
    shareManualCopy: "Text kopieren",
    shareManualDownload: "Datei herunterladen",
    shareManualFull: "Der Text überschreitet das Limit dieser Website, daher enthält der Knopf keinen Text (kopieren oder herunterladen)",
    shareManualHint: "Diese Website lässt sich nicht automatisch bespielen: Text und Bilder sind vorbereitet; kopiere sie oder öffne die Beitragsseite und veröffentliche selbst.",
    shareManualOpen: "Beitragsseite öffnen",
    shareSiteAdd: "Website hinzufügen",
    shareSiteCancel: "Abbrechen",
    shareSiteId: "Website-id",
    shareSiteLink: "Beitragsseite",
    shareSiteLoginKind: "Anmeldeart",
    shareSiteName: "Name",
    shareSiteNeeds: "erkannte Anforderungen",
    shareSitePh: "z. B. my-site (Buchstaben, Ziffern, - und _)",
    shareSiteRemove: "Website entfernen",
    shareSiteSave: "Hinzufügen",
    shareStageAccount: "Konto",
    shareStageSend: "Senden",
    shareStageVerify: "Prüfen",
    shareTextLimit: "diese Website nimmt {n} Zeichen",
  },
  "it-IT": {
    tab_people: "Persone",
    tab_calendar: "Calendario",
    sourceRegion: "Regione",
    loginCheckTitle: "Qui lo stato di accesso del browser viene letto in sola lettura (può restare aperto; nulla viene bloccato o modificato)",
    openInEditor: "Apri nell’editor",
    openInEditorFailed: "Impossibile aprire",
    openEditorTitle: "Come aprire i file",
    openEditorHint: "Lascia vuoto per usare l’editor configurato su questa macchina e, se manca, il metodo predefinito del sistema. Il valore è \"programma + argomenti\" e non passa mai da una shell; la richiesta porta solo tipo e nome del file, mentre il percorso lo risolve il server nelle proprie cartelle.",
    shareTextEdited: "questo è il testo che hai modificato (una copia propria di questo sito)",
    shareTextPrepared: "questo è il testo preparato dall’applicazione (già tagliato al limite di questo sito)",
    shareTextReset: "torna al testo preparato",
    shareTextPrepare: "rigenera il testo preparato",
    cookieDomain: "lettura dello stato di accesso di {domain}",
    noProfileDir: "Imposta prima la cartella dati del browser in Impostazioni → Browser, altrimenti lo stato di accesso non può essere letto",
    loginNotCheckable: "Questa fonte dichiara di non richiedere l’accesso: non c’è quindi alcuno stato di accesso da verificare",
    loginNoHost: "Questa destinazione non ha un dominio da leggere, quindi il suo stato di accesso non può essere verificato",
    loginFieldsEmpty: "Inserisci nome utente e BotPassword prima di verificare l’accesso",
    loginNoDiscovery: "non c’è modo di cercare un accesso di questo tipo (si trova un solo tipo di accesso), quindi viene riferito ciò che manca",
    shareAccountPick: "Account da usare",
    shareCheck: "Controlla cosa manca",
    shareConfig: "Configura",
    shareImages: "Immagini",
    shareImagesCount: "Massimo per file",
    shareManual: "Pubblicazione manuale",
    shareManualCopy: "Copia testo",
    shareManualDownload: "Scarica file",
    shareManualFull: "Il testo supera il limite di questo sito, quindi il pulsante non porta testo (usa copia o scarica)",
    shareManualHint: "Questo sito non accetta la pubblicazione automatica: testo e immagini sono pronti; copiali o apri la pagina di pubblicazione e pubblica tu.",
    shareManualOpen: "Apri pagina di pubblicazione",
    shareSiteAdd: "Aggiungi sito",
    shareSiteCancel: "Annulla",
    shareSiteId: "id del sito",
    shareSiteLink: "pagina di pubblicazione",
    shareSiteLoginKind: "Modo di accesso",
    shareSiteName: "Nome",
    shareSiteNeeds: "requisiti rilevati",
    shareSitePh: "per esempio my-site (lettere, cifre, - e _)",
    shareSiteRemove: "Rimuovi sito",
    shareSiteSave: "Aggiungi",
    shareStageAccount: "Account",
    shareStageSend: "Invia",
    shareStageVerify: "Verifica",
    shareTextLimit: "questo sito accetta {n} caratteri",
  },
  "ru-RU": {
    tab_people: "Персоны",
    tab_calendar: "Календарь",
    sourceRegion: "Регион",
    loginCheckTitle: "Здесь состояние входа браузера читается только для чтения (он может быть открыт; ничего не блокируется и не меняется)",
    openInEditor: "Открыть в редакторе",
    openInEditorFailed: "Не удалось открыть",
    openEditorTitle: "Как открывать файлы",
    openEditorHint: "Оставьте пустым, чтобы использовать настроенный на этой машине редактор, а если его нет — способ системы по умолчанию. Значение — это «программа + аргументы», и оно никогда не проходит через оболочку; в запросе только вид и имя файла, а путь сервер разрешает в своих каталогах вывода.",
    shareTextEdited: "это текст, который вы отредактировали (своя копия для этого сайта)",
    shareTextPrepared: "это текст, подготовленный приложением (уже обрезан по лимиту этого сайта)",
    shareTextReset: "вернуться к подготовленному тексту",
    shareTextPrepare: "создать подготовленный текст заново",
    cookieDomain: "читается состояние входа для {domain}",
    noProfileDir: "Сначала укажите каталог данных браузера в «Настройки → Браузер», иначе состояние входа прочитать нельзя",
    loginNotCheckable: "Этот источник заявлен как не требующий входа, поэтому проверять нечего",
    loginNoHost: "У этого объекта нет домена для чтения, поэтому его состояние входа проверить нельзя",
    loginFieldsEmpty: "Введите имя пользователя и BotPassword, прежде чем проверять вход",
    loginNoDiscovery: "способа найти вход такого типа нет (находится только один тип входа), поэтому сообщается, чего не хватает",
    shareAccountPick: "Какой аккаунт",
    shareCheck: "Проверить, чего не хватает",
    shareConfig: "Настроить",
    shareImages: "Изображения",
    shareImagesCount: "Не больше на файл",
    shareManual: "Публикация вручную",
    shareManualCopy: "Скопировать текст",
    shareManualDownload: "Скачать файл",
    shareManualFull: "Текст длиннее лимита этого сайта, поэтому в кнопке текста нет (используйте копирование или скачивание)",
    shareManualHint: "Этот сайт не принимает автоматическую публикацию: текст и изображения готовы; скопируйте их или откройте страницу публикации и опубликуйте сами.",
    shareManualOpen: "Открыть страницу публикации",
    shareSiteAdd: "Добавить сайт",
    shareSiteCancel: "Отмена",
    shareSiteId: "id сайта",
    shareSiteLink: "страница публикации",
    shareSiteLoginKind: "Способ входа",
    shareSiteName: "Название",
    shareSiteNeeds: "обнаруженные требования",
    shareSitePh: "например my-site (буквы, цифры, - и _)",
    shareSiteRemove: "Удалить сайт",
    shareSiteSave: "Добавить",
    shareStageAccount: "Аккаунт",
    shareStageSend: "Отправка",
    shareStageVerify: "Проверка",
    shareTextLimit: "этот сайт принимает {n} символов",
  },
  "uk-UA": {
    tab_people: "Персони",
    tab_calendar: "Календар",
    sourceRegion: "Регіон",
    loginCheckTitle: "Тут стан входу браузера читається лише для читання (він може бути відкритий; нічого не блокується й не змінюється)",
    openInEditor: "Відкрити в редакторі",
    openInEditorFailed: "Не вдалося відкрити",
    openEditorTitle: "Як відкривати файли",
    openEditorHint: "Залиште порожнім, щоб скористатися налаштованим на цій машині редактором, а якщо його немає — способом системи за замовчуванням. Значення — це «програма + аргументи», і воно ніколи не проходить через оболонку; у запиті лише вид і ім’я файлу, а шлях сервер визначає у власних каталогах виводу.",
    shareTextEdited: "це текст, який ви відредагували (власна копія для цього сайту)",
    shareTextPrepared: "це текст, підготовлений застосунком (уже обрізаний за лімітом цього сайту)",
    shareTextReset: "повернутися до підготовленого тексту",
    shareTextPrepare: "створити підготовлений текст заново",
    cookieDomain: "читається стан входу для {domain}",
    noProfileDir: "Спочатку вкажіть каталог даних браузера в «Налаштування → Браузер», інакше стан входу прочитати неможливо",
    loginNotCheckable: "Це джерело заявлено як таке, що не потребує входу, тому перевіряти нічого",
    loginNoHost: "У цієї цілі немає домену для читання, тому її стан входу перевірити не можна",
    loginFieldsEmpty: "Введіть ім’я користувача та BotPassword, перш ніж перевіряти вхід",
    loginNoDiscovery: "способу знайти вхід такого типу немає (знаходиться лише один тип входу), тому повідомляється, чого бракує",
    shareAccountPick: "Який акаунт",
    shareCheck: "Перевірити, чого бракує",
    shareConfig: "Налаштувати",
    shareImages: "Зображення",
    shareImagesCount: "Не більше на файл",
    shareManual: "Публікація вручну",
    shareManualCopy: "Копіювати текст",
    shareManualDownload: "Завантажити файл",
    shareManualFull: "Текст довший за ліміт цього сайту, тому кнопка не містить тексту (скористайтеся копіюванням або завантаженням)",
    shareManualHint: "Цей сайт не приймає автоматичну публікацію: текст і зображення готові; скопіюйте їх або відкрийте сторінку публікації та опублікуйте самі.",
    shareManualOpen: "Відкрити сторінку публікації",
    shareSiteAdd: "Додати сайт",
    shareSiteCancel: "Скасувати",
    shareSiteId: "id сайту",
    shareSiteLink: "сторінка публікації",
    shareSiteLoginKind: "Спосіб входу",
    shareSiteName: "Назва",
    shareSiteNeeds: "виявлені вимоги",
    shareSitePh: "наприклад my-site (літери, цифри, - і _)",
    shareSiteRemove: "Видалити сайт",
    shareSiteSave: "Додати",
    shareStageAccount: "Акаунт",
    shareStageSend: "Надсилання",
    shareStageVerify: "Перевірка",
    shareTextLimit: "цей сайт приймає {n} символів",
  },
  "pl-PL": {
    tab_people: "Osoby",
    tab_calendar: "Kalendarz",
    sourceRegion: "Region",
    loginCheckTitle: "Tutaj stan zalogowania przeglądarki jest odczytywany tylko do odczytu (może być otwarta; nic nie jest blokowane ani zmieniane)",
    openInEditor: "Otwórz w edytorze",
    openInEditorFailed: "Nie udało się otworzyć",
    openEditorTitle: "Sposób otwierania",
    openEditorHint: "Pozostaw puste, aby użyć edytora ustawionego na tym komputerze, a gdy go nie ma — domyślnego sposobu systemu. Wartość to „program + argumenty” i nigdy nie przechodzi przez powłokę; żądanie niesie tylko rodzaj i nazwę pliku, a ścieżkę ustala serwer we własnych katalogach wyjściowych.",
    shareTextEdited: "to jest tekst przez Ciebie zmieniony (własna kopia dla tej witryny)",
    shareTextPrepared: "to jest tekst przygotowany przez aplikację (już przycięty do limitu tej witryny)",
    shareTextReset: "wróć do przygotowanego tekstu",
    shareTextPrepare: "utwórz przygotowany tekst od nowa",
    cookieDomain: "odczyt stanu zalogowania dla {domain}",
    noProfileDir: "Najpierw ustaw katalog danych przeglądarki w Ustawienia → Przeglądarka, inaczej stanu zalogowania nie można odczytać",
    loginNotCheckable: "To źródło deklaruje, że nie wymaga logowania, więc nie ma stanu zalogowania do sprawdzenia",
    loginNoHost: "Ten cel nie ma domeny do odczytu, więc jego stanu zalogowania nie można sprawdzić",
    loginFieldsEmpty: "Wpisz nazwę użytkownika i BotPassword, zanim sprawdzisz logowanie",
    loginNoDiscovery: "nie ma sposobu, by znaleźć logowanie tego typu (znajdowany jest tylko jeden typ logowania), więc zgłaszane jest to, czego brakuje",
    shareAccountPick: "Które konto",
    shareCheck: "Sprawdź, czego brakuje",
    shareConfig: "Konfiguruj",
    shareImages: "Obrazy",
    shareImagesCount: "Maksymalnie na plik",
    shareManual: "Publikacja ręczna",
    shareManualCopy: "Kopiuj tekst",
    shareManualDownload: "Pobierz plik",
    shareManualFull: "Tekst przekracza limit tej witryny, więc przycisk nie zawiera tekstu (użyj kopiowania lub pobierania)",
    shareManualHint: "Ta witryna nie przyjmuje publikacji automatycznej: tekst i obrazy są gotowe; skopiuj je albo otwórz stronę publikacji i opublikuj sam.",
    shareManualOpen: "Otwórz stronę publikacji",
    shareSiteAdd: "Dodaj witrynę",
    shareSiteCancel: "Anuluj",
    shareSiteId: "id witryny",
    shareSiteLink: "strona publikacji",
    shareSiteLoginKind: "Sposób logowania",
    shareSiteName: "Nazwa",
    shareSiteNeeds: "wykryte wymagania",
    shareSitePh: "np. my-site (litery, cyfry, - i _)",
    shareSiteRemove: "Usuń witrynę",
    shareSiteSave: "Dodaj",
    shareStageAccount: "Konto",
    shareStageSend: "Wysyłka",
    shareStageVerify: "Weryfikacja",
    shareTextLimit: "ta witryna przyjmuje {n} znaków",
  },
  "sr-RS": {
    tab_people: "Особе",
    tab_calendar: "Календар",
    sourceRegion: "Регион",
    loginCheckTitle: "Овде се стање пријаве прегледача чита само за читање (може бити отворен; ништа се не закључава нити мења)",
    openInEditor: "Отвори у уређивачу",
    openInEditorFailed: "Није успело отварање",
    openEditorTitle: "Начин отварања",
    openEditorHint: "Оставите празно да се користи уређивач подешен на овом рачунару, а ако га нема — подразумевани начин система. Вредност је „програм + аргументи” и никада не пролази кроз љуску; захтев носи само врсту и име датотеке, а путању сервер разрешава у својим излазним директоријумима.",
    shareTextEdited: "ово је текст који сте изменили (сопствена копија за овај сајт)",
    shareTextPrepared: "ово је текст који је припремила апликација (већ скраћен на ограничење овог сајта)",
    shareTextReset: "назад на припремљени текст",
    shareTextPrepare: "поново направи припремљени текст",
    cookieDomain: "чита се стање пријаве за {domain}",
    noProfileDir: "Прво подесите директоријум података прегледача у Подешавања → Прегледач, иначе се стање пријаве не може прочитати",
    loginNotCheckable: "Овај извор је декларисан као да не захтева пријаву, па нема шта да се провери",
    loginNoHost: "Ова мета нема домен за читање, па се њено стање пријаве не може проверити",
    loginFieldsEmpty: "Унесите корисничко име и BotPassword пре провере пријаве",
    loginNoDiscovery: "не постоји начин да се пронађе пријава ове врсте (проналази се само једна врста пријаве), па се пријављује шта недостаје",
    customNamePh: "Нечији блог",
    shareAccountPick: "Који налог",
    shareCheck: "Провери шта недостаје",
    shareConfig: "Подеси",
    shareImages: "Слике",
    shareImagesCount: "Највише по датотеци",
    shareManual: "Ручна објава",
    shareManualCopy: "Копирај текст",
    shareManualDownload: "Преузми датотеку",
    shareManualFull: "Текст прелази ограничење овог сајта, па дугме не носи текст (користите копирање или преузимање)",
    shareManualHint: "Овај сајт не прима аутоматску објаву: текст и слике су припремљени; копирајте их или отворите страницу за објаву и објавите сами.",
    shareManualOpen: "Отвори страницу за објаву",
    shareSiteAdd: "Додај сајт",
    shareSiteCancel: "Откажи",
    shareSiteId: "id сајта",
    shareSiteLink: "страница за објаву",
    shareSiteLoginKind: "Начин пријаве",
    shareSiteName: "Назив",
    shareSiteNeeds: "откривени захтеви",
    shareSitePh: "нпр. my-site (слова, цифре, - и _)",
    shareSiteRemove: "Уклони сајт",
    shareSiteSave: "Додај",
    shareStageAccount: "Налог",
    shareStageSend: "Слање",
    shareStageVerify: "Провера",
    shareTextLimit: "овај сајт прима {n} знакова",
  },
  "fil-PH": {
    sourceRegion: "Rehiyon",
    loginCheckTitle: "Dito binabasa nang read-only ang estado ng pag-login ng browser (puwedeng bukas ito; walang nalolog o nababago)",
    cookieDomain: "binabasa ang estado ng pag-login ng {domain}",
    noProfileDir: "Itakda muna ang folder ng datos ng browser sa Mga setting → Browser, kung hindi ay hindi mababasa ang estado ng pag-login",
    loginNotCheckable: "Sinasabi ng pinagmulang ito na hindi kailangan ang pag-login, kaya walang estado ng pag-login na masusuri",
    loginNoHost: "Walang domain na mababasa ang target na ito, kaya hindi masusuri ang estado ng pag-login nito",
    loginFieldsEmpty: "Ilagay ang username at BotPassword bago suriin ang pag-login",
    loginNoDiscovery: "walang paraan upang mahanap ang ganitong uri ng login (isang uri lang ng login ang nakikita), kaya ang iniuulat ay ang kulang",
    openInEditor: "Buksan sa editor",
    openInEditorFailed: "Hindi nabuksan",
    openEditorTitle: "Paraan ng pagbukas",
    openEditorHint: "Iwanang blangko para gamitin ang editor na nakaayos sa makina, at kung wala ay ang default na paraan ng system. Ang halaga ay \"pangalan ng programa + mga argumento\" at hindi dumadaan sa shell; ang kahilingan ay nagdadala lamang ng uri at pangalan ng file, at ang landas ay hinahanap ng server sa sarili nitong mga folder.",
    shareAccountPick: "Account na gagamitin",
    shareCheck: "Tingnan ang kailangan",
    shareConfig: "Isaayos",
    shareImages: "Mga larawan",
    shareImagesCount: "Pinakamarami bawat file",
    shareManual: "Manu-manong pag-post",
    shareManualCopy: "Kopyahin ang teksto",
    shareManualDownload: "I-download ang file",
    shareManualFull: "Lumampas ang teksto sa limitasyon ng site na ito, kaya walang teksto sa button (gamitin ang kopya o download)",
    shareManualHint: "Hindi kayang awtomatikong mag-post sa site na ito: nakahanda na ang teksto at mga larawan; kopyahin ang mga ito o buksan ang pahina ng pag-post at ikaw ang mag-post.",
    shareManualOpen: "Buksan ang pahina ng pag-post",
    shareSiteAdd: "Magdagdag ng site",
    shareSiteCancel: "Kanselahin",
    shareSiteId: "id ng site",
    shareSiteLink: "pahina ng pag-post",
    shareSiteLoginKind: "Paraan ng pag-login",
    shareSiteName: "Pangalan",
    shareSiteNeeds: "mga natukoy na kailangan",
    shareSitePh: "hal. my-site (titik, bilang, - at _)",
    shareSiteRemove: "Alisin ang site",
    shareSiteSave: "Idagdag",
    shareStageAccount: "Account",
    shareStageSend: "Ipadala",
    shareStageVerify: "Beripika",
    shareTextLimit: "tumatanggap ang site na ito ng {n} karakter",
    shareTextEdited: "ito ang tekstong iyong inedit (sariling kopya para sa site na ito)",
    shareTextPrepared: "ito ang tekstong inihanda ng app (naikli na ayon sa limitasyon ng site na ito)",
    shareTextReset: "bumalik sa inihandang teksto",
    shareTextPrepare: "gawing muli ang inihandang teksto",
  },
  "ar-SA": {
    tab_people: "الأشخاص",
    tab_calendar: "التقويم",
    sourceRegion: "المنطقة",
    loginCheckTitle: "هنا تُقرأ حالة تسجيل الدخول في المتصفح للقراءة فقط (يمكن أن يبقى مفتوحًا، دون قفل أو تعديل)",
    openInEditor: "فتح في المحرر",
    openInEditorFailed: "تعذّر الفتح",
    openEditorTitle: "طريقة فتح الملفات",
    openEditorHint: "اتركه فارغًا لاستخدام المحرر المضبوط على هذا الجهاز، وإلا فسيُستخدم أسلوب النظام الافتراضي. القيمة هي «اسم البرنامج + الوسائط» ولا تمر عبر صدفة؛ الطلب يحمل النوع واسم الملف فقط، والمسار يحلّه الخادم داخل مجلدات مخرجاته.",
    cookieDomain: "جارٍ قراءة حالة تسجيل الدخول لـ {domain}",
    noProfileDir: "حدِّد أولًا مجلد بيانات المتصفح من الإعدادات ← المتصفح، وإلا فلا يمكن قراءة حالة تسجيل الدخول",
    loginNotCheckable: "يصرّح هذا المصدر بأنه لا يحتاج إلى تسجيل دخول، فلا توجد حالة تسجيل دخول لفحصها",
    loginNoHost: "لا يوجد لهذا الهدف نطاق يمكن قراءته، لذا لا يمكن فحص حالة تسجيل الدخول",
    loginFieldsEmpty: "أدخل اسم المستخدم وكلمة مرور البوت قبل فحص تسجيل الدخول",
    loginNoDiscovery: "لا توجد طريقة للعثور على تسجيل دخول من هذا النوع (يُعثر على نوع واحد فقط)، لذلك يبلّغ عمّا ينقص",
    outsideRange: "عناصر مستبعدة بسبب شرط الوقت",
    shareAccountPick: "الحساب المستخدم",
    shareCheck: "تحقق مما يلزم",
    shareConfig: "إعداد",
    shareImages: "الصور",
    shareImagesCount: "الحد الأقصى لكل ملف",
    shareManual: "نشر يدوي",
    shareManualCopy: "نسخ النص",
    shareManualDownload: "تنزيل الملف",
    shareManualFull: "النص يتجاوز حد هذا الموقع، لذلك لا يحمل الزر النص (استخدم النسخ أو التنزيل)",
    shareManualHint: "هذا الموقع لا يقبل النشر التلقائي: النص والصور جاهزة، انسخها أو افتح صفحة النشر وانشر بنفسك.",
    shareManualOpen: "فتح صفحة النشر",
    shareSiteAdd: "إضافة موقع",
    shareSiteCancel: "إلغاء",
    shareSiteId: "معرّف الموقع",
    shareSiteLink: "صفحة النشر",
    shareSiteLoginKind: "طريقة تسجيل الدخول",
    shareSiteName: "الاسم",
    shareSiteNeeds: "المتطلبات المكتشفة",
    shareSitePh: "مثال my-site (حروف وأرقام و - و _)",
    shareSiteRemove: "حذف الموقع",
    shareSiteSave: "إضافة",
    shareStageAccount: "الحساب",
    shareStageSend: "الإرسال",
    shareStageVerify: "التحقق",
    shareTextLimit: "هذا الموقع يقبل {n} حرفًا",
    shareTextEdited: "هذا هو النص الذي عدّلته (نسخة خاصة بهذا الموقع)",
    shareTextPrepared: "هذا هو النص الذي أعدّه التطبيق (مقصوص على حدّ هذا الموقع)",
    shareTextReset: "العودة إلى النص المُعدّ",
    shareTextPrepare: "إعادة إنشاء النص المُعدّ",
  },
};

/**
 * High-visibility entries (each language's second batch) / high-visibility strings
 *
 * These 40 keys are what a user sees as soon as the UI opens: common actions, states, field names,
 * main panel titles.
 * Translating them first is worth more than translating 400 long sentences such as the self-check
 * advice - how readable the UI is depends mainly on these frequent short words.
 *
 * Coverage is measurable: `node tools/locale-coverage.mjs` computes how much each language actually
 * covers (counting only what it provides itself, not what falls back to English) and writes the
 * result into a baseline that pins the floor.
 */
export const HAND_COMMON = {
  'ja-JP': {
    saveStateIdle: '変更なし',
    saveStateDirty: '未保存の変更があります',
    cancel: 'キャンセル',
    refresh: '更新',
    loading: '読み込み中…',
    error: 'エラー',
    yes: 'はい',
    no: 'いいえ',
    enabled: '有効',
    disabled: '無効',
    date: '日付',
    source: 'ソース',
    sources: 'ソース',
    searchTitle: '情報検索',
    reportsTitle: 'レポート',
    eventsTitle: '統合されたイベント',
    chartsTitle: '推移グラフ',
    shareTitle: '共有',
    shareDownload: '生成してダウンロード',
    shareCopy: 'テキストをコピー',
    intelTitle: '情報カード',
    runTitle: '収集を実行',
    done: '完了',
    failed: '失敗',
    alerts: 'アラート',
    noItems: 'まだ情報がありません',
    onlyAlerts: 'アラートのみ',
    onlyStarred: 'スターのみ',
    onlyUnread: '未読のみ',
    mergeEvents: '重複イベントを統合',
    packetLoss: 'パケット損失',
    save: '保存',
    saving: '保存中…',
    saved: '保存しました',
    add: '追加',
    delete: '削除',
    name: '名前',
    time: '時刻',
    language: '言語',
    latency: '遅延',
  },
  'ko-KR': {
    saveStateIdle: '변경 없음',
    saveStateDirty: '저장하지 않은 변경 사항',
    cancel: '취소',
    refresh: '새로 고침',
    loading: '불러오는 중…',
    error: '오류',
    yes: '예',
    no: '아니요',
    enabled: '사용',
    disabled: '사용 안 함',
    date: '날짜',
    source: '소스',
    sources: '소스',
    searchTitle: '정보 검색',
    reportsTitle: '보고서',
    eventsTitle: '통합된 이벤트',
    chartsTitle: '추이 그래프',
    shareTitle: '공유',
    shareDownload: '생성 후 다운로드',
    shareCopy: '텍스트 복사',
    intelTitle: '정보 카드',
    runTitle: '수집 실행',
    done: '완료',
    failed: '실패',
    alerts: '알림',
    noItems: '아직 정보가 없습니다',
    onlyAlerts: '알림만',
    onlyStarred: '별표만',
    onlyUnread: '읽지 않음만',
    mergeEvents: '중복 이벤트 통합',
    packetLoss: '패킷 손실',
    save: '저장',
    saving: '저장 중…',
    saved: '저장했습니다',
    add: '추가',
    delete: '삭제',
    name: '이름',
    time: '시간',
    language: '언어',
    latency: '지연',
    // Hand-written: machine translation cannot rescue this sentence. The model **deterministically**
    // answers in Chinese for this long sentence (I tried changing the prompt and switching to a
    // "finish this half-done translation" task, and it still produced the same Chinese-Korean
    // mixture), so by the layering rule the hand-written layer takes over - hand-written always
    // beats machine, and a long prompt sentence like this should go through a human once anyway.
    liveHint:
      '방송 시작은 가장 시의성이 높은 정보입니다 — 어떤 키워드보다 먼저 알아야 할 일이죠. ' +
      '여기서는 모니터링 대상의 방송 상태를 보여 주고, 여러 방송을 격자로 펼쳐 동시에 볼 수 있습니다' +
      '(빌리빌리 공식 임베드 플레이어를 쓰며, 어떤 중계도 거치지 않고 로그인 정보도 건드리지 않습니다). ' +
      '「연속 재생」은 실제 방송 시작이 아니므로 따로 표시합니다.',
  },
  'id-ID': {
    // The 41 high-visibility entries, written by hand before the machine pass runs: the machine
    // layer may not override a hand entry (see humanKeys() in tools/i18n-translate.mjs), so these
    // are both the copy a user sees first and the values the pipeline is not allowed to touch.
    saveStateIdle: 'Belum ada perubahan',
    saveStateDirty: 'Ada perubahan yang belum disimpan',
    cancel: 'Batal',
    refresh: 'Muat ulang',
    loading: 'Memuat…',
    error: 'Galat',
    yes: 'Ya',
    no: 'Tidak',
    enabled: 'Aktif',
    disabled: 'Nonaktif',
    date: 'Tanggal',
    source: 'Sumber',
    sources: 'Sumber',
    searchTitle: 'Pencarian informasi',
    reportsTitle: 'Laporan',
    eventsTitle: 'Peristiwa gabungan',
    chartsTitle: 'Grafik tren',
    shareTitle: 'Bagikan',
    shareDownload: 'Buat lalu unduh',
    shareCopy: 'Salin teks',
    intelTitle: 'Kartu informasi',
    runTitle: 'Jalankan pengumpulan',
    done: 'Selesai',
    failed: 'Gagal',
    alerts: 'Peringatan',
    noItems: 'Belum ada informasi',
    onlyAlerts: 'Hanya peringatan',
    onlyStarred: 'Hanya berbintang',
    onlyUnread: 'Hanya belum dibaca',
    mergeEvents: 'Gabungkan peristiwa kembar',
    packetLoss: 'Kehilangan paket',
    save: 'Simpan',
    saving: 'Menyimpan…',
    saved: 'Tersimpan',
    add: 'Tambah',
    delete: 'Hapus',
    name: 'Nama',
    time: 'Waktu',
    language: 'Bahasa',
    latency: 'Latensi',
    // Carried here instead of left to the machine pass, for the reason recorded for Korean above:
    // this is a long prompt sentence, and a long sentence is exactly where a machine pass leaves the
    // source language behind. A hand entry always wins, so this one never depends on the model.
    liveHint:
      'Mulai siaran adalah intel paling sensitif waktu — lebih layak langsung diketahui ' +
      'daripada kata kunci mana pun. Di sini ditampilkan status siaran dari objek pemantauan, ' +
      'dan beberapa ruang siaran bisa langsung disusun menjadi kisi untuk ditonton bersamaan ' +
      '(memakai pemutar sematan resmi bilibili, tanpa perantara dan tanpa menyentuh status masuk). ' +
      'Perhatikan bahwa "putar ulang" bukan siaran yang benar-benar mulai, jadi ditandai terpisah.',
    // ── Corrections to the first machine pass, all of them kept here (never in machine.json,
    //    which the pipeline regenerates): a hand entry wins over the machine layer.
    //    Each note quotes the Chinese source string it is about, which is the one case
    //    docs/ENGLISH-LOGIC.md section 3 allows the `english-logic:allow` marker for: the character
    //    itself is the subject of the sentence, not a Chinese explanation kept around. The marker is
    //    per line because the guard reads one `//` line at a time.
    //
    // 1. broken count label. The zh source is "{n} 个" and the model returned a bare "{n}" with the english-logic:allow
    //    noun gone, so the UI rendered "12" on its own where it means "12 cookie". Every other
    //    locale's machine entry kept a unit (ja "{n} 個" / de "{n} Stück" / ru "{n} шт."). Indonesian english-logic:allow
    //    has no plural table (one category, `other`), so the number stays prepended and the only
    //    thing that has to be right here is the noun.
    cookieCount: '{n} cookie',
    cookieCountWithSession: '{n} cookie (termasuk SESSDATA)',
    // 2. Chinese left in the value. The zh source names a follow target in Chinese (盯日箱, a english-logic:allow
    //    glossary term, so looksUntranslated() strips it before testing and the pipeline cannot see
    //    it); the English source does not, and the model carried it into the Indonesian sentence.
    //    A Chinese proper noun sitting inside an Indonesian hint is exactly the "half-translated
    //    string" the layering rule is for, so the example is replaced with the Latin-script one the
    //    English copy uses.
    calHint:
      'Hitung mundur ulang tahun, hari debut, 3D reveal, dan anniversary. "Hari ini" dihitung ' +
      'menurut zona waktu yang ditandai di bawah (di Pengaturan bisa diubah ke zona waktu ' +
      'orangnya, misalnya Asia/Tokyo kalau mengikuti agensi Jepang); ulang tahun 29 Februari pada ' +
      'tahun bukan kabisat digeser ke 1 Maret dan ditandai, bukan dihitung salah diam-diam.',
    // 3. An English word left inside an Indonesian sentence. `关注对象` is in the glossary with english-logic:allow
    //    default "Followed people" -- a Latin term, so the pipeline substitutes it rather than
    //    translating it, and the model happily embedded the English noun phrase in the middle of
    //    Indonesian copy (the same shape as the documented "term protection cuts compounds in
    //    half" pitfall, in the other direction). The glossary is shared with the 24 other locales,
    //    so the fix belongs here and not in glossary.json.
    chartsPeople: 'Aktivitas orang yang diikuti',
    peopleMatched: 'cocok dengan orang yang diikuti',
    vdbTitle: 'Impor orang yang diikuti dari VDB',
    groupNoAgency: 'Belum ada orang yang diikuti dengan agensi',
    // 4. Dropped head verb (`监视对象` = the watch targets): the model wrote "VDBFollowed people" english-logic:allow
    //    with no space in one case and put the English noun in the modifier slot in the others.
    watchDigest: 'Ringkasan perubahan pantauan',
    runWatchOnly: 'Periksa hanya objek pantauan',
    taskMode_watch: 'Hanya objek pantauan',
    // 5. Plural where the source is singular (`来源` = one field label), so the form header read english-logic:allow
    //    "Sources" in the Indonesian table.
    field_source: 'Sumber',
    sourcesTitle: 'Sumber',
    eventsSources: 'sumber',
    chartsSources: 'Porsi sumber dan peringatan',
  },
  'fil-PH': {
    // Filipino joined one release after Indonesian, and its hand layer is written first for the same
    // reason: the machine layer may not override a hand entry (see humanKeys() in
    // tools/i18n-translate.mjs), so the copy a user meets first is decided here rather than by the
    // model. The Filipino tag is `fil-PH`, not `tl-PH` (see locales/index.js).
    saveStateIdle: 'Wala pang pagbabago',
    saveStateDirty: 'May mga pagbabagong hindi pa naka-save',
    cancel: 'Kanselahin',
    refresh: 'I-refresh',
    loading: 'Naglo-load…',
    error: 'Error',
    yes: 'Oo',
    no: 'Hindi',
    enabled: 'Naka-on',
    disabled: 'Naka-off',
    date: 'Petsa',
    source: 'Pinagmulan',
    sources: 'Pinagmulan',
    searchTitle: 'Paghahanap ng impormasyon',
    reportsTitle: 'Mga ulat',
    eventsTitle: 'Pinagsamang mga kaganapan',
    chartsTitle: 'Mga graph ng trend',
    shareTitle: 'Ibahagi',
    shareDownload: 'Gumawa at i-download',
    shareCopy: 'Kopyahin ang teksto',
    intelTitle: 'Daloy ng impormasyon',
    runTitle: 'Magpatakbo',
    done: 'Tapos na',
    failed: 'Nabigo',
    alerts: 'Mga babala',
    noItems: 'Wala pang impormasyon',
    onlyAlerts: 'Mga babala lang',
    onlyStarred: 'Mga naka-star lang',
    onlyUnread: 'Mga hindi pa nababasa lang',
    mergeEvents: 'Pagsamahin ang magkatulad na kaganapan',
    packetLoss: 'Pagkawala ng packet',
    save: 'I-save',
    saving: 'Nagse-save…',
    saved: 'Naka-save',
    add: 'Magdagdag',
    delete: 'Tanggalin',
    name: 'Pangalan',
    time: 'Oras',
    language: 'Wika',
    latency: 'Latency',
    // The same reasoning the Korean and Indonesian levels recorded for this one: it is a long prompt
    // sentence, which is exactly where a machine pass leaves the source language behind, and it is
    // the first thing a user reads on the Live page. A hand entry always wins, so this sentence never
    // depends on the model.
    liveHint:
      'Ang pagsisimula ng live stream ang pinaka-sensitibo sa oras na impormasyon — mas mahalaga ' +
      'pang malaman agad kaysa sa kahit anong keyword. Dito ipinapakita ang status ng live stream ng ' +
      'mga sinusubaybayan, at puwede mong isaayos ang ilang silid sa isang grid para sabay na ' +
      'panoorin (gamit ang opisyal na embed player ng bilibili, walang relay at walang paggamit ng ' +
      'login). Tandaan na ang "replay" ay hindi tunay na pagsisimula ng live, kaya hiwalay itong ' +
      'minarkahan.',
    // ── The count labels, and why they are handled by a plural table rather than by the base values.
    //
    // docs/DESIGN.md section 11 and tools/i18n-plural-test.mjs both assume a two-tier world: a
    // language either inflects (a `<key>_<category>` table in locales/plurals.js) or it does not
    // (zh / ja / ko / id, where prepending the number is already correct). Filipino is in neither
    // tier, and the measurement is the reason. `Intl.PluralRules('fil')` reports two categories
    // (`one`, `other`) -- so the study's "28 plural forms" figure is arithmetically right -- and the
    // split is by last digit: measured over 0..2000, `other` is selected exactly when `n % 10` is
    // 4, 6 or 9 (30% of integers), `one` for everything else. (The first probe of this read its own
    // evidence wrong -- it spot-checked 0/1/2/3/5/10/11/21/100, all of which are `one`, and concluded
    // "every integer is `one`". The corrected numbers are in locales/plurals.js next to the table.)
    //
    // What Filipino requires is not inflection but the **linker**: Tagalog puts `na` (or the bound
    // `-ng`) between a numeral and the noun it counts (`5 na item`, `2 na araw`), so the default
    // "number in front of a bare noun" of countLabel() renders `2 item`, a fragment rather than a
    // noun phrase. The wording therefore lives in the table (PLURALS['fil-PH'] in locales/plurals.js),
    // where `{n}` sits inside the phrase, and the base values below stay bare nouns -- exactly the
    // split the other inflecting locales use, and exactly what the "count label lost its noun" guard
    // in tools/i18n-proofread.mjs expects of a count key.
    //
    // Cost of not doing this: Thai's classifier problem in a different form -- count labels that read
    // as broken word order to a native speaker while every offline gate stays green.
    items: 'item',
    groupDays: 'araw',
    // The English value for this one is the abbreviation "p"; Filipino gets the word.
    groupPeopleUnit: 'tao',
    vdbGroups: 'grupo',
    outsideRange: 'hindi kasama ng filter ng oras',
    groupMembers: 'miyembro',
    groupPeopleCount: 'sinusubaybayang tao',
    costCalls: 'tawag',
    matches: 'tugma',
    // `alerts` is a count key as well as the copy for its row (zh "告警"): the panel label wants the english-logic:allow
    // plural marker, but `tn('alerts', n)` prepends a number to this value, so the base has to be the
    // bare noun or the UI renders "1 Mga babala".
    alerts: 'Babala',
    // ── Corrections to the machine pass itself, all kept here rather than in machine.json, which the
    //    pipeline regenerates and would happily overwrite. A hand entry wins over the machine layer
    //    (see humanKeys() in tools/i18n-translate.mjs), so these are the values a user actually sees.
    //
    // 1. An English noun phrase in the two titles the machine left in English. The zh sources are
    //    "监视对象" (the watch targets) and "来源" (sources); the pipeline returned the English words english-logic:allow
    //    "Watch object" and "Sources", i.e. two of the eleven tab-row/panel titles a Filipino user
    //    meets first were still English. The glossary has its own agreed wording for both terms, and
    //    the tab labels above use it, so these follow the same words instead of the model's.
    watchTitle: 'Subaybayan',
    sourcesTitle: 'Pinagmulan',
    // 2. The same failure in a sentence: zh "开播监测与多屏观看" (live monitoring and multi-screen english-logic:allow
    //    viewing) came back as "Live monitoring at multi-screen viewing" -- English, and not even
    //    grammatical English. Mixed-language chrome is the exact defect the whole locale chain exists
    //    to avoid, so it is hand-written.
    liveTitle: 'Katayuan ng live at multi-screen na panonood',
    //
    // 3. A meaning-inverting mistranslation. zh "出口" is the *egress route* (how a source is reached: english-logic:allow
    //    direct or through the proxy), and the machine read it as 导出 / "export" -- `proxyMode` became english-logic:allow
    //    "I-export", so the settings page told the user to export something. The English source says
    //    "Egress". In a settings row next to "direct" / "proxy" the label has to keep that meaning.
    proxyMode: 'Ruta ng labasan',
    // 4. A wrong word class on a weekday label. zh "星期" is the generic "day of week" header of the english-logic:allow
    //    scheduled-task table; the machine returned "Linggo", which is the proper noun **Sunday**, so
    //    the column header named one day instead of the column.
    dayOfWeek: 'Araw ng linggo',
    // 5. A past-tense count rendered as an imperative. zh "扫描条目" is the result label "entries english-logic:allow
    //    scanned" (shown after a VDB scan); the machine wrote "I-scan ang mga entry" -- "scan the
    //    entries" -- which is an instruction, not a result.
    peopleScanned: 'Mga na-scan na entry',
    // 6. Two values glued together with no space: zh "从 VDB 导入关注对象" came back as english-logic:allow
    //    "I-import mula sa VDBFollowed people", producing the nonsense token "VDBFollowed" where the
    //    glossary term 关注对象 had been substituted. 关注对象 is a pinned term with a Filipino english-logic:allow
    //    override ("Sinusubaybayan") that this row should have used.
    vdbTitle: 'I-import ang mga sinusubaybayan mula sa VDB',
    // 7. 通贩 (merch sales) rendered as "mail-order", which is not the word this UI uses anywhere english-logic:allow
    //    else (every other row says merch). Also a possessive where the source has none.
    onlyDaily: 'Regular lang (patay ang merch)',
    // 8. A half-translated parenthetical: zh "标识（英文/数字/短横线）" describes the *characters* the id english-logic:allow
    //    may contain, and the machine kept the English "Identifier" and translated 英文 as the language english-logic:allow
    //    name "English". Latin letters, not the English language.
    sourceId: 'Identifier (letra/numero/gitling)',
    //
    // 9. A systematic habit rather than a single row, and the largest part of this list: short labels
    //    and enum values came back as the English string while their own hints were translated. Each
    //    one is a label a user reads on its own, so "the hint explains it in Filipino" does not help.
    //    The Chinese sources are ordinary words, not product names, which is why they are repaired here
    //    instead of being left alone like bilibili / YouTube / VDB.
    multiScreen: 'Sabay-sabay na screen', // zh 多屏 english-logic:allow
    addAllLive: 'Idagdag lahat ng live sa sabay-sabay na screen', // zh 在播的全部加入多屏 english-logic:allow
    addToGrid: 'Idagdag sa sabay-sabay na screen', // zh 加入多屏 english-logic:allow
    clearGrid: 'I-clear ang sabay-sabay na screen', // zh 清空多屏 english-logic:allow
    headless: 'Mode na walang window', // zh 无头模式 english-logic:allow
    customSources: 'Mga sariling source', // zh 自定义来源 english-logic:allow
    addCustomSource: 'Magdagdag ng sariling source', // zh 新增自定义来源 english-logic:allow
    browserTitle: 'Browser na ginagamit', // zh 浏览器 english-logic:allow
    proxyTitle: 'Proxy ng network', // zh 网络代理 english-logic:allow
    notifyKind: 'Uri ng channel', // zh 通道 english-logic:allow
    notifySecret: 'Susi ng pagpirma', // zh 加签密钥 english-logic:allow
    notifyOn: 'Kondisyon na nag-trigger', // zh 触发条件 english-logic:allow
    obsJitter: 'Agwat ng jitter', // zh 间隔抖动 english-logic:allow
    anonymousMode: 'Anonymong mode', // zh 匿名模式 english-logic:allow
    privacyTitle: 'Privacy / Inkognito', // zh 隐私 / 无痕 english-logic:allow
    // 10. Consistency rows, not mistakes: the same concept had two Filipino values in the same file, so
    //     one of them is wrong wherever the other is right. `notify` is the same zh/en string as
    //     `desktopNotify` (which reads "Abiso sa desktop"), `notifyQuiet` is the pinned glossary term
    //     静默时段 whose override is "Tahimik na oras", and `mode_tor` said "Walang bakas" ("no trace") english-logic:allow
    //     while every other row for the same mode says Incognito/anon.
    notify: 'Abiso sa desktop', // zh 桌面通知 english-logic:allow
    notifyQuiet: 'Tahimik na oras', // zh 静默时段 english-logic:allow
    mode_tor: 'Tor (Inkognito)', // zh Tor（无痕） english-logic:allow
    // The three keys whose zh source already embeds the numeral ("{n} 个" and "粉丝 {n}") keep a english-logic:allow
    // value with `{n}` here, because that is what the source itself carries -- the guard's
    // placeholder comparison is against the Chinese string, so a base value without it would be the
    // mismatch instead.
    cookieCount: '{n} na cookie',
    cookieCountWithSession: '{n} na cookie (kasama ang SESSDATA)',
    // followersCount is the one count key whose zh source puts the numeral *after* the noun, so the
    // Filipino value does the same and the tested `{n}` rule for this key is unaffected.
    followersCount: 'tagasubaybay {n}',
  },
  'th-TH': {
    // Thai joined one release after Filipino, and its hand layer is written first for the same
    // reason: the machine layer may not override a hand entry (see humanKeys() in
    // tools/i18n-translate.mjs), so the copy a user meets first is decided here rather than by the
    // model. The tag is `th-TH`, not `th` (see locales/index.js).
    saveStateIdle: 'ยังไม่มีการเปลี่ยนแปลง',
    saveStateDirty: 'มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก',
    cancel: 'ยกเลิก',
    refresh: 'รีเฟรช',
    loading: 'กำลังโหลด…',
    error: 'ข้อผิดพลาด',
    yes: 'ใช่',
    no: 'ไม่ใช่',
    enabled: 'เปิด',
    disabled: 'ปิด',
    date: 'วันที่',
    source: 'แหล่งข้อมูล',
    sources: 'แหล่งข้อมูล',
    searchTitle: 'ค้นหาข้อมูล',
    reportsTitle: 'รายงาน',
    eventsTitle: 'เหตุการณ์ที่รวมแล้ว',
    chartsTitle: 'กราฟแนวโน้ม',
    shareTitle: 'แชร์',
    shareDownload: 'สร้างแล้วดาวน์โหลด',
    shareCopy: 'คัดลอกข้อความ',
    intelTitle: 'การ์ดข้อมูล',
    runTitle: 'เรียกเก็บข้อมูล',
    done: 'เสร็จสิ้น',
    failed: 'ล้มเหลว',
    alerts: 'การแจ้งเตือน',
    noItems: 'ยังไม่มีข้อมูล',
    onlyAlerts: 'เฉพาะการแจ้งเตือน',
    onlyStarred: 'เฉพาะที่ติดดาว',
    onlyUnread: 'เฉพาะที่ยังไม่ได้อ่าน',
    mergeEvents: 'รวมเหตุการณ์ที่ซ้ำกัน',
    packetLoss: 'แพ็กเก็ตสูญหาย',
    save: 'บันทึก',
    saving: 'กำลังบันทึก…',
    saved: 'บันทึกแล้ว',
    add: 'เพิ่ม',
    delete: 'ลบ',
    name: 'ชื่อ',
    time: 'เวลา',
    language: 'ภาษา',
    latency: 'ความหน่วง',
    // The same reasoning the Korean, Indonesian and Filipino levels recorded for this one: it is a
    // long prompt sentence, and a long sentence is exactly where a machine pass leaves the source
    // language behind - it is also the first thing a user reads on the Live page. A hand entry
    // always wins, so this sentence never depends on the model.
    //
    // Thai has no spaces between words; the spaces that do appear here separate clauses (and follow
    // the Thai convention of a space before the closing parenthesis of an aside), not words. That is
    // deliberate and is also why the fingerprinter cannot use them as word boundaries - see the
    // measurement recorded on the `th-TH` plural table in locales/plurals.js.
    liveHint:
      'การเริ่มไลฟ์สดเป็นข้อมูลที่อ่อนไหวต่อเวลามากที่สุด — ควรรู้ก่อนคำค้นใด ๆ ' +
      'หน้านี้แสดงสถานะการไลฟ์ของเป้าหมายที่เฝ้าติดตาม และจัดห้องไลฟ์หลายห้องเป็นตารางเพื่อดูพร้อมกันได้ ' +
      '(ใช้เครื่องเล่นฝังตัวทางการของ bilibili ไม่ผ่านตัวกลางและไม่แตะข้อมูลการเข้าสู่ระบบ) ' +
      'โปรดทราบว่า "เล่นซ้ำ" ไม่ใช่การเริ่มไลฟ์จริง จึงแสดงแยกไว้ต่างหาก',
    // ── The count labels, and why they are handled by a plural table rather than by the base values.
    //
    // docs/DESIGN.md section 11 describes the rule as three-tiered, with Filipino as the worked
    // example of the third tier. Thai is the same tier for a different reason, and the measurement
    // is again the reason rather than the category count:
    //
    //   `Intl.PluralRules('th').resolvedOptions().pluralCategories` is `["other"]` -- a single
    //   category, measured over 0..2000 as `other` for all 2001 integers, and for decimals too
    //   (1.5 / 2.5 / 100.5 all select `other`). So nothing inflects and the two-tier reading says
    //   "this locale is like zh / ja / ko / id: prepend the number to a bare noun".
    //
    //   That reading is wrong here. Thai counts with a numeral plus a **classifier** (`3 รายการ`,
    //   `2 วัน`, `5 ครั้ง`, `10 คน`); a numeral in front of a bare noun is not how a Thai count label
    //   is written, so "prepend the number" would produce something that reads like a database
    //   field. The classifier is a word that has to be *in* the phrase, which is precisely what a
    //   value without `{n}` cannot express -- and the category count cannot express the need either.
    //
    //   So the table below (PLURALS['th-TH'] in locales/plurals.js) carries each count key as a full
    //   Thai noun phrase, and the base values here stay the standalone noun the panel title uses.
    //   Where the classifier is already inside the noun (`การแจ้งเตือน`, `คุกกี้`), the table repeats
    //   it with `{n}` -- the point is that the count label is written out in full and phrased, and
    //   that nobody can "simplify" the key back into the bare-numeral tier without deleting a form.
    //
    // Cost of not doing this: count labels that read as broken Thai to a native speaker while every
    // offline gate stays green. tools/i18n-plural-test.mjs pins the measurement and the wording.
    items: 'รายการ',
    groupDays: 'วัน',
    // The English value for this one is the abbreviation "p"; Thai gets the word, like Filipino.
    groupPeopleUnit: 'คน',
    vdbGroups: 'กลุ่ม',
    outsideRange: 'รายการที่ถูกตัดออกตามเงื่อนไขเวลา',
    groupMembers: 'สมาชิก',
    groupPeopleCount: 'คนที่ติดตาม',
    costCalls: 'ครั้ง',
    matches: 'รายการ',
    // `alerts` is a count key as well as the copy for its row (zh "告警"), so the base has to work as english-logic:allow
    // a standalone panel label; here the noun already contains the notion of "notification", which
    // is why the table's entry only has to add the numeral.
    alerts: 'การแจ้งเตือน',
    // ── Corrections to the machine pass itself, all kept here rather than in machine.json, which the
    //    pipeline regenerates and would happily overwrite. A hand entry wins over the machine layer
    //    (see humanKeys() in tools/i18n-translate.mjs), so these are the values a user actually sees.
    //    Every note below either quotes the machine's own `th-TH` output verbatim (and names the
    //    defect a Thai user would notice) or says plainly that the row is a consistency decision in
    //    this file. No style preferences are encoded here.
    //
    // The Chinese source strings are quoted inside `english-logic:allow` markers: the guard reads one
    // `//` line at a time, so every line that carries a Chinese character needs its own marker (see
    // docs/ENGLISH-LOGIC.md section 3).
    //
    // 1. Two glossary terms substituted into the sentence and left glued to their neighbours, so the
    //    UI renders tokens that are not Thai words. The pinned term 来源 (sources) came back as english-logic:allow
    //    "แหล่งข้อมูล" joined straight onto the platform name ("เปิดใช้งาน bilibiliแหล่งข้อมูล ใดก็ได้"),
    //    and 监视 (watch) came back as "การเฝ้าติดตาม" wrapped in spaces as a standalone fragment english-logic:allow
    //    ("ยังไม่มีวัตถุที่สามารถ การเฝ้าติดตาม ได้"). This is the "term protection cuts compounds in
    //    half" pitfall of docs/DESIGN.md section 11 seen from the other side: the substitution is
    //    right, the sentence around it is not. Thai has no word spaces, so a glued term cannot be
    //    read as two words - it is one nonsense token.
    liveNoTargets: 'ยังไม่มีเป้าหมายให้เฝ้าติดตาม —— เปิดใช้แหล่งข้อมูล bilibili แหล่งใดก็ได้ หรือเพิ่ม uid ด้วยตนเอง',
    // The same glued term in a shorter label: zh "监视列表需要账号名与 BotPassword" came back as english-logic:allow
    // "รายการ การเฝ้าติดตาม ต้องใช้ชื่อบัญชีและ BotPassword" -- the fragment "การเฝ้าติดตาม" sits between
    // spaces where the noun phrase belongs.
    needBotPassword: 'รายการเฝ้าติดตามต้องใช้ชื่อผู้ใช้และ BotPassword',
    // 2. A copy-paste collision: two different source strings came back word for word identical, so
    //    two different empty states read the same. zh "尚无运行记录" (no run records yet) and english-logic:allow
    //    the scheduled-task history zh "还没有执行记录" (no execution history yet) were both english-logic:allow
    //    translated as "ยังไม่มีบันทึกการทำงาน". The second row is about a *schedule*, which the
    //    shared wording does not say, and the two rows sit on two different pages.
    noResult: 'ยังไม่มีบันทึกการรัน',
    noScheduleHistory: 'ยังไม่มีประวัติการเรียกเก็บข้อมูล',
    // 3. A model failure the pipeline itself rejected. The run reported "obsHint: retranslation still
    //    the source text, not written" and "obsRotationHint: ... not written" -- the second pass came
    //    back with Han characters again, so by the layering rule nothing was written and both rows
    //    would have fallen back to **English** inside the Thai observation-mode block, whose switch
    //    and sibling hints are Thai. Hand-written here for that reason, not because the wording was
    //    wrong: there was no wording.
    obsHint:
      'เมื่อเฝ้าดูทั้งค่าย ร่องรอยการเข้าชมก็เป็นข้อมูลเช่นกัน: การไล่เก็บสมาชิกทุกคนพร้อมกัน ' +
      'ในเวลาเดิมของทุกวัน ด้วยช่วงห่างที่เท่ากันเป๊ะ — รูปแบบเหล่านี้ไม่เกี่ยวกับว่าคุณมาจาก IP ใด ' +
      'เมื่อเปิดใช้ โปรแกรมจะสุ่มเก็บเพียงบางส่วนในแต่ละรอบ (หมุนเวียนให้ครบ) เว้นช่วงแบบสุ่ม ' +
      'และให้เฉพาะแหล่งข้อมูลที่บันทึกของอีกฝ่ายอยู่บนเซิร์ฟเวอร์ของเขาเองผ่าน Tor',
    obsRotationHint:
      'ต้องเปลี่ยนทางออกของ Tor ทุกครั้งจึงจะไม่ถูกมองว่าเป็นผู้เข้าชมรายเดิม ' +
      'การแยกทางออกใช้ชื่อผู้ใช้ SOCKS ของ Tor และให้เฉพาะแหล่งข้อมูลที่อีกฝ่ายเก็บบันทึกเองผ่าน Tor ' +
      '(bilibili / Reddit / Fandom วิ่งตรง เพราะอีกฝ่ายไม่เห็นบันทึกเหล่านั้น และทาง Tor ช้ากว่าประมาณ 8 เท่า)',
    // 4. A half-translated label: zh "标识（英文/数字/短横线）" says which *characters* an id may contain, and english-logic:allow
    //    the machine returned "ตัวระบุ (อังกฤษ/ตัวเลข/ขีดกลาง)" -- it kept "ตัวระบุ" in Latin (fine, that
    //    is the field's name) but translated 英文 as อังกฤษ, the name of the English *language* and the english-logic:allow
    //    country adjective. The row accepts Latin letters, not the English language; Filipino hit the
    //    identical defect.
    sourceId: 'ตัวระบุ (อักษรละติน/ตัวเลข/ขีดกลาง)',
    // 5. A leading space in a field label: zh "忽略行正则" came back as " regex ข้ามบรรทัด", so the input english-logic:allow
    //    rendered with a stray space in front of it. (Structural, and the proofreader's
    //    leading/trailing-whitespace rule is what caught it.)
    ignorePatterns: 'regex ข้ามบรรทัด',
    // 6. A glossary term that the machine transliterated while the hand layer used the Thai word:
    //    zh "在播的全部加入多屏" came back using "มัลติวิว" (a transliteration of "multi-view") for 多屏 english-logic:allow
    //    where the row that turns the grid off says "หน้าจอหลายจอ". One concept, one wording -- and the
    //    two buttons sit next to each other in the same toolbar, so a user reads both in one glance.
    addAllLive: 'เพิ่มห้องไลฟ์ทั้งหมดลงหน้าจอหลายจอ',
    // 7. Consistency rows rather than machine failures - the machine never produced an entry for these
    //    keys (they are the hand-written titles below), so what follows is a decision recorded here:
    //    the same concept must have one Thai value in the file. `watchTitle` / `watchDigest` /
    //    `runWatchOnly` / `taskMode_watch` are the four places the watch *target* appears; three of
    //    them render as เป้าหมาย that the Thai reader cannot tie back to the watch feature, so all four
    //    use เป้าหมายที่เฝ้าติดตาม, which is also what the glossary override for 关注对象 says in every english-logic:allow
    //    hint around them.
    watchTitle: 'เป้าหมายที่เฝ้าติดตาม',
    watchDigest: 'สรุปการเปลี่ยนแปลงของเป้าหมายที่เฝ้าติดตาม',
    runWatchOnly: 'ตรวจสอบเฉพาะเป้าหมายที่เฝ้าติดตาม',
    taskMode_watch: 'เฉพาะเป้าหมายที่เฝ้าติดตาม',
    // The same decision for the other repeated concepts: 来源 (sources) is แหล่งข้อมูล everywhere (the english-logic:allow
    // glossary override agrees), 桌面通知 (desktop notification) is การแจ้งเตือนบนเดสก์ท็อป as the machine english-logic:allow
    // translated the sibling key `desktopNotify`, 静默时段 (quiet hours) is the glossary's ช่วงเวลาสงบ, english-logic:allow
    // and 通道 (channel) is ช่องทาง as in every channel row on the notification panel. english-logic:allow
    sourcesTitle: 'แหล่งข้อมูล',
    notify: 'การแจ้งเตือนบนเดสก์ท็อป',
    notifyQuiet: 'ช่วงเวลาสงบ',
    notifyKind: 'ประเภทช่องทาง',
    // 8. A result label rendered as an instruction, the class Filipino also recorded: zh "扫描条目" is the english-logic:allow
    //    count of entries a VDB scan examined, shown after the scan, and a bare "รายการ" leaves it
    //    reading as a menu item rather than a result.
    peopleScanned: 'รายการที่สแกนแล้ว',
    // 9. The short labels for the multi-screen grid, the custom-source editor and the privacy rows.
    //    These are hand-written for the same reason as everything above: the machine never produced a
    //    value for them, because at the time of the run they were already in the hand layer (the
    //    pipeline skips keys the hand layer owns), so leaving them out here drops the row to the
    //    English fallback -- which the proofreader then reports as "this row is really an English
    //    fallback", and a Thai user reads "Multi-screen" in the middle of a Thai toolbar.
    //
    //    Every one of them uses the wording already established by the row it sits next to:
    //    หน้าจอหลายจอ for 多屏 (the same phrase `addAllLive` above and the liveHint sentence use), english-logic:allow
    //    แหล่งข้อมูล for 来源 (the glossary override), plain Thai words for the privacy / network rows english-logic:allow
    //    because none of them is a product name.
    multiScreen: 'หน้าจอหลายจอ', // zh 多屏 english-logic:allow
    addToGrid: 'เพิ่มลงหน้าจอหลายจอ', // zh 加入多屏 english-logic:allow
    clearGrid: 'ล้างหน้าจอหลายจอ', // zh 清空多屏 english-logic:allow
    customSources: 'แหล่งข้อมูลที่กำหนดเอง', // zh 自定义来源 english-logic:allow
    addCustomSource: 'เพิ่มแหล่งข้อมูลที่กำหนดเอง', // zh 新增自定义来源 english-logic:allow
    browserTitle: 'เบราว์เซอร์ที่ใช้', // zh 浏览器 english-logic:allow
    proxyTitle: 'พร็อกซีเครือข่าย', // zh 网络代理 english-logic:allow
    headless: 'โหมดไม่มีหน้าต่าง', // zh 无头模式 english-logic:allow
    anonymousMode: 'โหมดไม่ระบุตัวตน', // zh 匿名模式 english-logic:allow
    privacyTitle: 'ความเป็นส่วนตัว / ไม่ระบุตัวตน', // zh 隐私 / 无痕 english-logic:allow
    vdbTitle: 'นำเข้าคนที่ติดตามจาก VDB', // zh 从 VDB 导入关注对象 english-logic:allow
    // The three keys whose zh source already embeds the numeral ("{n} 个" and "粉丝 {n}") keep a english-logic:allow
    // value with `{n}` here, because that is what the source itself carries -- the guard's
    // placeholder comparison is against the Chinese string, so a base value without it would be the
    // mismatch instead.
    cookieCount: '{n} คุกกี้',
    cookieCountWithSession: '{n} คุกกี้ (รวม SESSDATA)',
    // followersCount is the one count key whose zh source puts the numeral *after* the noun, so the
    // Thai value does the same and the tested `{n}` rule for this key is unaffected.
    followersCount: 'ผู้ติดตาม {n}',
  },
  'vi-VN': {
    // Vietnamese joined as the 29th locale, and its hand layer is written first for the same reason
    // Filipino and Thai wrote theirs first: the machine layer may not override a hand entry (see
    // humanKeys() in tools/i18n-translate.mjs), so the copy a user meets first is decided here
    // rather than by the model. The tag is `vi-VN`, never the bare `vi` (see locales/index.js).
    saveStateIdle: 'Chưa có thay đổi',
    saveStateDirty: 'Có thay đổi chưa lưu',
    cancel: 'Hủy',
    refresh: 'Làm mới',
    loading: 'Đang tải…',
    error: 'Lỗi',
    yes: 'Cần',
    no: 'Không cần',
    enabled: 'Bật định kỳ',
    disabled: 'Tắt định kỳ',
    date: 'Ngày',
    source: 'Nguồn',
    sources: 'Nguồn',
    // The Search page title. The machine pass returned "Truy xuất thông tin" (retrieval, database
    // jargon) while this page's own placeholder and every other row that mentions searching say
    // "tìm kiếm" -- one concept rendered two ways inside one page, so the page title follows the
    // wording the rest of the page uses.
    searchTitle: 'Tìm kiếm thông tin',
    reportsTitle: 'Báo cáo',
    eventsTitle: 'Sự kiện đã hợp nhất',
    chartsTitle: 'Biểu đồ xu hướng',
    shareTitle: 'Chia sẻ',
    shareDownload: 'Tạo và tải xuống',
    shareCopy: 'Sao chép văn bản',
    intelTitle: 'Dòng thẻ thông tin',
    runTitle: 'Chạy',
    done: 'Hoàn thành',
    failed: 'Thất bại',
    noItems: 'Chưa có thông tin',
    onlyAlerts: 'Chỉ mục khớp từ khóa',
    onlyStarred: 'Chỉ mục gắn sao',
    onlyUnread: 'Chỉ mục chưa đọc',
    mergeEvents: 'Gộp sự kiện trùng lặp',
    packetLoss: 'Mất gói',
    save: 'Lưu',
    saving: 'Đang lưu…',
    saved: 'Đã lưu',
    add: 'Thêm',
    delete: 'Xóa',
    name: 'Tên',
    time: 'Thời gian',
    language: 'Ngôn ngữ',
    latency: 'Độ trễ',
    // The same reasoning the Korean, Indonesian, Filipino and Thai levels recorded for this one: it
    // is a long prompt sentence, and a long sentence is exactly where a machine pass leaves the
    // source language behind - it is also the first thing a user reads on the Live page. A hand
    // entry always wins, so this sentence never depends on the model. The machine pass had produced
    // a usable sentence that still carried English inside it (it called the rooms "phòng live" and
    // wrapped the rerun note in the corner brackets the source uses), so this wording drops both.
    liveHint:
      'Phát trực tiếp là loại thông tin có tính thời sự nhất — đáng để biết ngay hơn bất kỳ từ khóa nào. ' +
      'Trang này hiển thị trạng thái phát trực tiếp của các đối tượng theo dõi, và có thể xếp nhiều phòng ' +
      'thành một lưới để xem cùng lúc (dùng trình phát nhúng chính thức của bilibili, không qua bất kỳ máy ' +
      'chủ trung gian nào và không đụng đến trạng thái đăng nhập). Lưu ý: "phát lại" không phải là phát ' +
      'trực tiếp thật, nên được đánh dấu riêng.',
    // ── The count labels, and why Vietnamese needs **no** form table.
    //
    // docs/DESIGN.md section 11 describes the rule as three-tiered: a locale that inflects gets a
    // `<key>_<category>` table, a locale that does not keeps the number in front of a bare noun, and
    // a locale can need a table for a reason the form count cannot express (Filipino's `na` linker,
    // Thai's classifier). Vietnamese is the *second* tier, and the measurement is what puts it there
    // rather than the form count alone:
    //
    //   `Intl.PluralRules('vi').resolvedOptions().pluralCategories` is `["other"]` -- one category.
    //   Measured over 0..2000, all 2001 integers select `other`; decimals (0.5 / 1.5 / 2.5 / 100.5)
    //   select it too, and so do 0, 1 and 1e6. So nothing inflects, and a table could hold exactly
    //   one form per key -- which is the same shape that puts zh / ja / ko / id in the second tier.
    //
    //   The half a category count cannot see is word order, and that is where Vietnamese parts
    //   company with Thai and Filipino rather than resembling them. Thai needs its classifier as a
    //   separate obligatory word (`3 รายการ`), Tagalog needs the linker `na` (`5 na item`); both are
    //   words that are not the noun, so "number in front of a bare noun" renders a fragment.
    //   Vietnamese puts the numeral directly in front of the unit word, and for every count key here
    //   that unit word IS the head noun: `12 mục`, `2 ngày`, `4 người`, `4 nhóm`, `5 thành viên`,
    //   `5 lượt gọi`, `3 kết quả khớp`, `6 cảnh báo`, `36 cookie`, `128 người theo dõi`. Where
    //   Vietnamese does require a classifier (`3 con mèo`, `2 quyển sách`) it belongs to
    //   individual-object nouns, which is a class none of these keys counts.
    //
    // So the wording lives in the base values below, `countLabel()` prepends the numeral, and
    // tools/i18n-plural-test.mjs pins the measurement, these rendered labels and the absence of a
    // table -- so the locale cannot be "simplified" into a table by analogy with Thai, and the
    // classifier-bearing nouns cannot be dropped out of the base values either.
    items: 'mục',
    groupDays: 'ngày',
    // The English value for this one is the abbreviation "p"; Vietnamese gets the word, like Thai and
    // Filipino do.
    groupPeopleUnit: 'người',
    vdbGroups: 'nhóm',
    outsideRange: 'mục bị loại bởi bộ lọc thời gian',
    groupMembers: 'thành viên',
    groupPeopleCount: 'người được theo dõi',
    costCalls: 'lượt gọi',
    matches: 'kết quả khớp',
    // `alerts` is a count key as well as the copy for its row (zh "告警"): the panel label wants the english-logic:allow
    // capitalised form, but `tn('alerts', n)` prepends a number to this value, so the base stays lower
    // case -- "6 cảnh báo" is a count label, "6 Cảnh báo" is not. The label position is decided by the
    // rows below instead.
    alerts: 'cảnh báo',
    // ── Corrections to the machine pass itself, all of them kept here rather than in machine.json,
    //    which the pipeline regenerates and would happily overwrite. A hand entry wins over the
    //    machine layer (see humanKeys() in tools/i18n-translate.mjs), so these are the values a user
    //    actually sees. Every note quotes the machine's own `vi-VN` output and names the defect a
    //    Vietnamese reader would notice; no style preference is encoded here.
    //
    // The Chinese source strings are quoted inside `english-logic:allow` markers: the guard reads one
    // `//` line at a time, so every line carrying a Chinese character needs its own marker (see
    // docs/ENGLISH-LOGIC.md section 3).
    //
    // 1. A meaning inversion. zh "出口" is the *egress route* (how a source is reached: direct or english-logic:allow
    //    through the proxy) and the machine read it as the everyday "output" -- `proxyMode` came back
    //    as "Đầu ra", so a settings row sitting next to "direct" / "proxy" named a pipe instead of a
    //    route. English says "Egress". Filipino and Thai hit the same word.
    proxyMode: 'Lối ra mạng',
    // 2. A result label rendered as an instruction. zh "扫描条目" is the count of entries a VDB scan english-logic:allow
    //    examined, shown after the scan, and the machine wrote "Quét mục" -- "scan entries" -- which is
    //    an imperative. The same class Filipino and Thai recorded.
    peopleScanned: 'Mục đã quét',
    // 3. A glossary term glued to the token in front of it, plus Vietnamese word order thrown away.
    //    zh "从 VDB 导入关注对象" came back as "Nhập từ VDB đối tượng theo dõi": the pinned term english-logic:allow
    //    关注对象 (vi "đối tượng theo dõi") is appended straight after the platform name with no english-logic:allow
    //    grammar between them, and the object of the sentence ends up after its source. It is the same
    //    "VDBFollowed people" defect Filipino recorded, one locale later.
    vdbTitle: 'Nhập đối tượng theo dõi từ VDB',
    // 4. A half-translated parenthetical. zh "标识（英文/数字/短横线）" lists the *characters* an id may english-logic:allow
    //    contain; the machine wrote "Định danh (chữ Anh/số/gạch ngang)", i.e. 英文 as "chữ Anh" -- the english-logic:allow
    //    name of the English *language*, not Latin letters. The row accepts Latin letters. Filipino
    //    and Thai hit the identical defect.
    sourceId: 'Định danh (chữ Latinh/số/gạch ngang)',
    // 5. A wrong word class on a column header. zh "星期" is the generic "day of week" header of the english-logic:allow
    //    scheduled-task table, and the machine returned "Thứ" -- the ordinal prefix that opens the
    //    weekday names (Thứ Hai = Monday) with no noun attached, so the header named a series of
    //    ordinals rather than the column. Filipino's "Linggo" (Sunday) was this defect the other way
    //    round.
    dayOfWeek: 'Ngày trong tuần',
    // 6. A label that collides with the privacy row next to it. zh "无头模式" is headless (the browser english-logic:allow
    //    runs with no window); the machine wrote "Chế độ ẩn" ("hidden mode"), which reads as a stealth
    //    switch -- and this settings page already has "Chế độ ẩn danh" for anonymous mode one row
    //    away, so the two would be read as the same feature.
    headless: 'Chế độ không cửa sổ',
    // 7. Three buttons of one toolbar describing the wrong action, and one of them with no noun. The
    //    machine produced "Thêm tất cả đang phát vào nhiều màn hình" for 在播的全部加入多屏 ("everything english-logic:allow
    //    that is live", with nothing being counted), "Tham gia nhiều màn hình" for 加入多屏 ("join the english-logic:allow
    //    multi-screen", as if joining a group) and "Xóa nhiều màn hình" for 清空多屏 ("delete several english-logic:allow
    //    screens"). All three sit in the same row beside the grid, so they name the same object with
    //    the same verb family -- the consistency decision Thai recorded for its grid buttons.
    multiScreen: 'Nhiều màn hình',
    addAllLive: 'Thêm mọi phòng đang phát vào nhiều màn hình',
    addToGrid: 'Thêm vào nhiều màn hình',
    clearGrid: 'Xóa hết khỏi nhiều màn hình',
    // 8. Two sentences whose first word stayed lower case after the machine pass, because the pinned
    //    term inside them is substituted in lower case (the rule recorded in glossary.json's
    //    `_note_en`): "lưu trữ là SQLite ghi tăng dần ..." and "nguồn là 'đơn vị thu thập' ...".
    //    Vietnamese capitalises the first word of a sentence, so both take a capital -- and the second
    //    one also had English left inside it ("alias") in an otherwise Vietnamese sentence.
    chartsHint:
      'Lưu trữ là SQLite ghi tăng dần (mỗi ngày chạy sẽ thêm vào, bỏ qua mục đã tồn tại). Biểu đồ vẽ bằng ' +
      'SVG nội tuyến, không dùng thư viện biểu đồ — bản di động không nên vì vài cột mà mang thêm vài trăm KB.',
    peopleHint:
      'Nguồn là "đơn vị thu thập", thứ bạn thực sự quan tâm là "người". Điền tên và tài khoản vào, chương ' +
      'trình sẽ gán thông tin cho người ngay trên máy (khớp chuỗi thuần, không lên mạng, không dùng LLM), và ' +
      'hiển thị mỗi lần khớp là bí danh nào khớp ở trường nào — phán đoán luôn có thể giải thích. Báo cáo ' +
      'ngày và thông báo đẩy cũng sẽ tổng hợp theo người; đặt mức thông báo của một người thành urgent, tin ' +
      'của họ sẽ được miễn giờ yên tĩnh.',
    // 9. English left inside an otherwise Vietnamese sentence: the hint for zh "自定义来源" ends english-logic:allow
    //    "... một trang cần trình duyệt render". "render" is a developer word; the sibling rows say
    //    "kết xuất" (the proxy hint uses exactly that verb), so the hint follows them.
    customSourcesHint:
      'Với các trang mà nguồn tích hợp không bao phủ, bạn có thể tự thêm: một RSS, một MediaWiki API, một ' +
      'UID bilibili, hoặc một trang cần trình duyệt kết xuất.',
    // 10. Short labels whose only defect is the case rule from the glossary note: the substituted term
    //     is lower case inside a sentence, but these keys render it as a standalone label, so they take
    //     a capital. The machine rows are "nguồn", "lưu trữ", "giờ yên tĩnh", "thông tin gần nhất",
    //     "nguồn ↗". (`sources` / `source` are in the batch above.) The machine rows also mean
    //     "customSources" came back as "nguồn tùy chỉnh", i.e. head-final where Vietnamese puts the
    //     head first.
    sourcesTitle: 'Nguồn',
    field_source: 'Nguồn',
    eventsSources: 'Nguồn',
    viewSource: 'Nguồn ↗',
    chartsArchive: 'Lưu trữ',
    shareScopeLatest: 'Thông tin gần nhất',
    customSources: 'Nguồn tùy chỉnh',
    // 11. A live-status chip, and a consistency decision of the same kind: zh "监测中" came back as english-logic:allow
    //     "Trong Giám sát" -- a capitalised pinned term inside a phrase, plus a literal "inside" that
    //     reads as a container. The chip says the target is being monitored, so it uses the wording
    //     of `tab_watch` and `watchTitle`.
    liveMonitored: 'Đang theo dõi',
    // 12. Consistency rows rather than machine failures -- the machine agreed with the wording in
    //     most cases, and what follows is the decision that one concept must have one Vietnamese value
    //     in this file. `watchTitle` / `watchDigest` / `runWatchOnly` / `taskMode_watch` are the four
    //     places the watch *target* appears; all four now say "đối tượng theo dõi" (the pinned term's
    //     wording, lower case inside a phrase), and `watchDigest` also gained the "of" the machine left
    //     out -- "Tóm tắt thay đổi theo dõi" reads as "summary of changes following", while its three
    //     sibling rows do name the target.
    watchTitle: 'Đối tượng theo dõi',
    watchDigest: 'Tóm tắt thay đổi của đối tượng theo dõi',
    runWatchOnly: 'Chỉ kiểm tra đối tượng theo dõi',
    taskMode_watch: 'Chỉ kiểm tra đối tượng theo dõi',
    // The same decision for the other repeated concepts: 来源 (sources) is "nguồn" everywhere, english-logic:allow
    // 桌面通知 (desktop notification) is "Thông báo trên màn hình" as the machine translated both english-logic:allow
    // rows, 静默时段 (quiet hours) is the glossary override's "giờ yên tĩnh" with a capital when it english-logic:allow
    // stands alone as a title, and 通道 (channel) is "Kênh" as on every channel row of the english-logic:allow
    // notification panel.
    notify: 'Thông báo trên màn hình',
    notifyQuiet: 'Giờ yên tĩnh',
    quietTitle: 'Giờ yên tĩnh',
    notifyKind: 'Kênh',
    // 13. A panel title whose second half was capitalised after the slash ("Riêng tư / Ẩn danh"):
    //     Vietnamese capitalises the first word of a sentence, not the second half of a title, and
    //     "Quyền riêng tư" is the label a privacy panel carries.
    privacyTitle: 'Quyền riêng tư / ẩn danh',
    anonymousMode: 'Chế độ ẩn danh',
    liveTitle: 'Giám sát phát trực tiếp và xem nhiều màn hình',
    llmFeat_live: 'Giám sát phát trực tiếp và xem nhiều màn hình',
    // The three keys whose zh source already embeds the numeral ("{n} 个" and "粉丝 {n}") keep a english-logic:allow
    // value with `{n}` here, because that is what the source itself carries -- the guard's placeholder
    // comparison is against the Chinese string, so a base value without it would be the mismatch
    // instead. The machine's own count labels were "{n} cái" (the generic classifier with no noun at
    // all) and "Người theo dõi {n}"; Vietnamese puts the numeral first and names what is counted.
    cookieCount: '{n} cookie',
    cookieCountWithSession: '{n} cookie (gồm SESSDATA)',
    followersCount: '{n} người theo dõi',
  },
  'es-ES': {
    saveStateIdle: 'Sin cambios todavía',
    saveStateDirty: 'Cambios sin guardar',
    cancel: 'Cancelar',
    refresh: 'Actualizar',
    loading: 'Cargando…',
    error: 'Error',
    yes: 'Sí',
    no: 'No',
    enabled: 'Activado',
    disabled: 'Desactivado',
    date: 'Fecha',
    source: 'Fuente',
    sources: 'Fuentes',
    searchTitle: 'Búsqueda de información',
    reportsTitle: 'Informes',
    eventsTitle: 'Eventos fusionados',
    chartsTitle: 'Gráficos de tendencia',
    shareTitle: 'Compartir',
    shareDownload: 'Generar y descargar',
    shareCopy: 'Copiar texto',
    intelTitle: 'Tarjetas de información',
    runTitle: 'Ejecutar recogida',
    done: 'Hecho',
    failed: 'Falló',
    alerts: 'Alertas',
    noItems: 'Todavía no hay información',
    onlyAlerts: 'Solo alertas',
    onlyStarred: 'Solo destacados',
    onlyUnread: 'Solo no leídos',
    mergeEvents: 'Fusionar eventos duplicados',
    packetLoss: 'Pérdida de paquetes',
    save: 'Guardar',
    saving: 'Guardando…',
    saved: 'Guardado',
    add: 'Añadir',
    delete: 'Eliminar',
    name: 'Nombre',
    time: 'Hora',
    language: 'Idioma',
    latency: 'Latencia',
  },
  'pt-BR': {
    saveStateIdle: 'Nenhuma alteração ainda',
    saveStateDirty: 'Alterações não salvas',
    cancel: 'Cancelar',
    refresh: 'Atualizar',
    loading: 'Carregando…',
    error: 'Erro',
    yes: 'Sim',
    no: 'Não',
    enabled: 'Ativado',
    disabled: 'Desativado',
    date: 'Data',
    source: 'Fonte',
    sources: 'Fontes',
    searchTitle: 'Busca de informações',
    reportsTitle: 'Relatórios',
    eventsTitle: 'Eventos mesclados',
    chartsTitle: 'Gráficos de tendência',
    shareTitle: 'Compartilhar',
    shareDownload: 'Gerar e baixar',
    shareCopy: 'Copiar texto',
    intelTitle: 'Cartões de informação',
    runTitle: 'Executar coleta',
    done: 'Concluído',
    failed: 'Falhou',
    alerts: 'Alertas',
    noItems: 'Ainda não há informações',
    onlyAlerts: 'Somente alertas',
    onlyStarred: 'Somente favoritos',
    onlyUnread: 'Somente não lidos',
    mergeEvents: 'Mesclar eventos duplicados',
    packetLoss: 'Perda de pacotes',
    save: 'Salvar',
    saving: 'Salvando…',
    saved: 'Salvo',
    add: 'Adicionar',
    delete: 'Excluir',
    name: 'Nome',
    time: 'Hora',
    language: 'Idioma',
    latency: 'Latência',
  },
  'fr-FR': {
    saveStateIdle: 'Aucune modification',
    saveStateDirty: 'Modifications non enregistrées',
    cancel: 'Annuler',
    refresh: 'Actualiser',
    loading: 'Chargement…',
    error: 'Erreur',
    yes: 'Oui',
    no: 'Non',
    enabled: 'Activé',
    disabled: 'Désactivé',
    date: 'Date',
    source: 'Source',
    sources: 'Sources',
    searchTitle: 'Recherche d’informations',
    reportsTitle: 'Rapports',
    eventsTitle: 'Événements fusionnés',
    chartsTitle: 'Graphiques de tendance',
    shareTitle: 'Partager',
    shareDownload: 'Générer et télécharger',
    shareCopy: 'Copier le texte',
    intelTitle: 'Cartes d’information',
    runTitle: 'Lancer la collecte',
    done: 'Terminé',
    failed: 'Échec',
    alerts: 'Alertes',
    noItems: 'Pas encore d’informations',
    onlyAlerts: 'Alertes seulement',
    onlyStarred: 'Favoris seulement',
    onlyUnread: 'Non lus seulement',
    mergeEvents: 'Fusionner les doublons',
    packetLoss: 'Perte de paquets',
    save: 'Enregistrer',
    saving: 'Enregistrement…',
    saved: 'Enregistré',
    add: 'Ajouter',
    delete: 'Supprimer',
    name: 'Nom',
    time: 'Heure',
    language: 'Langue',
    latency: 'Latence',
  },
  'de-DE': {
    saveStateIdle: 'Noch keine Änderungen',
    saveStateDirty: 'Ungespeicherte Änderungen',
    cancel: 'Abbrechen',
    refresh: 'Aktualisieren',
    loading: 'Wird geladen…',
    error: 'Fehler',
    yes: 'Ja',
    no: 'Nein',
    enabled: 'Aktiviert',
    disabled: 'Deaktiviert',
    date: 'Datum',
    source: 'Quelle',
    sources: 'Quellen',
    searchTitle: 'Informationssuche',
    reportsTitle: 'Berichte',
    eventsTitle: 'Zusammengeführte Ereignisse',
    chartsTitle: 'Trenddiagramme',
    shareTitle: 'Teilen',
    shareDownload: 'Erzeugen und herunterladen',
    shareCopy: 'Text kopieren',
    intelTitle: 'Informationskarten',
    runTitle: 'Sammlung starten',
    done: 'Fertig',
    failed: 'Fehlgeschlagen',
    alerts: 'Warnungen',
    noItems: 'Noch keine Informationen',
    onlyAlerts: 'Nur Warnungen',
    onlyStarred: 'Nur markierte',
    onlyUnread: 'Nur ungelesene',
    mergeEvents: 'Doppelte Ereignisse zusammenführen',
    packetLoss: 'Paketverlust',
    save: 'Speichern',
    saving: 'Speichern…',
    saved: 'Gespeichert',
    add: 'Hinzufügen',
    delete: 'Löschen',
    name: 'Name',
    time: 'Uhrzeit',
    language: 'Sprache',
    latency: 'Latenz',
  },
  'it-IT': {
    saveStateIdle: 'Ancora nessuna modifica',
    saveStateDirty: 'Modifiche non salvate',
    cancel: 'Annulla',
    refresh: 'Aggiorna',
    loading: 'Caricamento…',
    error: 'Errore',
    yes: 'Sì',
    no: 'No',
    enabled: 'Attivo',
    disabled: 'Disattivo',
    date: 'Data',
    source: 'Fonte',
    sources: 'Fonti',
    searchTitle: 'Ricerca informazioni',
    reportsTitle: 'Report',
    eventsTitle: 'Eventi unificati',
    chartsTitle: 'Grafici di tendenza',
    shareTitle: 'Condividi',
    shareDownload: 'Genera e scarica',
    shareCopy: 'Copia testo',
    intelTitle: 'Schede informative',
    runTitle: 'Avvia raccolta',
    done: 'Fatto',
    failed: 'Non riuscito',
    alerts: 'Avvisi',
    noItems: 'Ancora nessuna informazione',
    onlyAlerts: 'Solo avvisi',
    onlyStarred: 'Solo preferiti',
    onlyUnread: 'Solo non letti',
    mergeEvents: 'Unisci eventi duplicati',
    packetLoss: 'Perdita di pacchetti',
    save: 'Salva',
    saving: 'Salvataggio…',
    saved: 'Salvato',
    add: 'Aggiungi',
    delete: 'Elimina',
    name: 'Nome',
    time: 'Ora',
    language: 'Lingua',
    latency: 'Latenza',
  },
  'ru-RU': {
    saveStateIdle: 'Изменений пока нет',
    saveStateDirty: 'Есть несохранённые изменения',
    cancel: 'Отмена',
    refresh: 'Обновить',
    loading: 'Загрузка…',
    error: 'Ошибка',
    yes: 'Да',
    no: 'Нет',
    enabled: 'Включено',
    disabled: 'Выключено',
    date: 'Дата',
    source: 'Источник',
    sources: 'Источники',
    searchTitle: 'Поиск по сводке',
    reportsTitle: 'Отчёты',
    eventsTitle: 'Объединённые события',
    chartsTitle: 'Графики динамики',
    shareTitle: 'Поделиться',
    shareDownload: 'Собрать и скачать',
    shareCopy: 'Скопировать текст',
    intelTitle: 'Карточки сводки',
    runTitle: 'Запустить сбор',
    done: 'Готово',
    failed: 'Не удалось',
    alerts: 'Оповещения',
    noItems: 'Сводки пока нет',
    onlyAlerts: 'Только оповещения',
    onlyStarred: 'Только избранное',
    onlyUnread: 'Только непрочитанные',
    mergeEvents: 'Объединять дубли событий',
    packetLoss: 'Потери пакетов',
    save: 'Сохранить',
    saving: 'Сохранение…',
    saved: 'Сохранено',
    add: 'Добавить',
    delete: 'Удалить',
    name: 'Название',
    time: 'Время',
    language: 'Язык',
    latency: 'Задержка',
  },
  'ar-SA': {
    saveStateIdle: 'لا تغييرات بعد',
    saveStateDirty: 'تغييرات غير محفوظة',
    cancel: 'إلغاء',
    refresh: 'تحديث',
    loading: 'جارٍ التحميل…',
    error: 'خطأ',
    yes: 'نعم',
    no: 'لا',
    enabled: 'مُفعّل',
    disabled: 'مُعطّل',
    date: 'التاريخ',
    source: 'المصدر',
    sources: 'المصادر',
    searchTitle: 'البحث في المعلومات',
    reportsTitle: 'التقارير',
    eventsTitle: 'الأحداث المدمجة',
    chartsTitle: 'مخططات الاتجاه',
    shareTitle: 'مشاركة',
    shareDownload: 'إنشاء وتنزيل',
    shareCopy: 'نسخ النص',
    intelTitle: 'بطاقات المعلومات',
    runTitle: 'بدء الجمع',
    done: 'تم',
    failed: 'فشل',
    alerts: 'التنبيهات',
    noItems: 'لا توجد معلومات بعد',
    onlyAlerts: 'التنبيهات فقط',
    onlyStarred: 'المميزة فقط',
    onlyUnread: 'غير المقروءة فقط',
    mergeEvents: 'دمج الأحداث المكررة',
    packetLoss: 'فقدان الحزم',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    add: 'إضافة',
    delete: 'حذف',
    name: 'الاسم',
    time: 'الوقت',
    language: 'اللغة',
    latency: 'زمن الاستجابة',
  },
};

/**
 * Each language's core UI entries.
 * Only the keys that are "visible at a glance": the UI is still usable with the English fallback,
 * but the core actions should be in the user's own language.
 */
export const HAND = {
  'ja-JP': {
    appSub: 'ローカル VTuber インテリジェンス',
    tab_intel: '情報',
    tab_run: '実行',
    tab_sources: 'ソース',
    tab_watch: 'ウォッチ',
    tab_settings: '設定',
    tab_reports: 'レポート',
    tab_live: 'ライブ',
    tab_search: '検索',
    tab_llm: 'LLM',
    save: '保存',
    saving: '保存中…',
    saved: '保存しました',
    delete: '削除',
    cancel: 'キャンセル',
    add: '追加',
    refresh: '更新',
    probe: '疎通テスト',
    loading: '読み込み中…',
    error: 'エラー',
    ok: 'OK',
    yes: 'はい',
    no: 'いいえ',
    on: 'オン',
    off: 'オフ',
    enabled: '有効',
    disabled: '無効',
    name: '名前',
    time: '時刻',
    date: '日付',
    source: 'ソース',
    sources: 'ソース',
    search: '検索',
    reports: 'レポート',
    settings: '設定',
    language: '言語',
    proxy: 'プロキシ',
    direct: '直接接続',
    auto: '自動',
    latency: '遅延',
    packetLoss: 'パケット損失',
  },
  'ko-KR': {
    appSub: '로컬 VTuber 인텔리전스',
    tab_intel: '정보',
    tab_run: '실행',
    tab_sources: '소스',
    tab_watch: '감시',
    tab_settings: '설정',
    tab_reports: '보고서',
    tab_live: '라이브',
    tab_search: '검색',
    tab_llm: 'LLM',
    save: '저장',
    saving: '저장 중…',
    saved: '저장했습니다',
    delete: '삭제',
    cancel: '취소',
    add: '추가',
    refresh: '새로 고침',
    probe: '연결 확인',
    loading: '불러오는 중…',
    error: '오류',
    yes: '예',
    no: '아니요',
    on: '켜기',
    off: '끄기',
    enabled: '사용',
    disabled: '사용 안 함',
    name: '이름',
    time: '시간',
    date: '날짜',
    source: '소스',
    sources: '소스',
    language: '언어',
    proxy: '프록시',
    direct: '직접 연결',
    auto: '자동',
    latency: '지연',
    packetLoss: '패킷 손실',
  },
  'es-ES': {
    appSub: 'Inteligencia VTuber local',
    tab_intel: 'Información',
    tab_run: 'Ejecutar',
    tab_sources: 'Fuentes',
    tab_watch: 'Vigilancia',
    tab_settings: 'Ajustes',
    tab_reports: 'Informes',
    tab_live: 'En directo',
    tab_search: 'Buscar',
    save: 'Guardar',
    saving: 'Guardando…',
    saved: 'Guardado',
    saveStateIdle: 'Sin cambios todavía',
    saveStateDirty: 'Cambios sin guardar: recuerda guardar',
    delete: 'Eliminar',
    cancel: 'Cancelar',
    add: 'Añadir',
    refresh: 'Actualizar',
    probe: 'Probar conexión',
    loading: 'Cargando…',
    error: 'Error',
    yes: 'Sí',
    no: 'No',
    enabled: 'Activado',
    disabled: 'Desactivado',
    name: 'Nombre',
    time: 'Hora',
    date: 'Fecha',
    language: 'Idioma',
    proxy: 'Proxy',
    direct: 'Conexión directa',
    auto: 'Automático',
    latency: 'Latencia',
    packetLoss: 'Pérdida de paquetes',
    fastest: 'más rápido',
  },
  'es-419': {
    // Latin-American wording differences (real differences, not a mechanical replacement)
    save: 'Guardar',
    delete: 'Borrar',
    add: 'Agregar',
    refresh: 'Refrescar',
    probe: 'Probar conexión',
    loading: 'Cargando…',
    enabled: 'Habilitado',
    disabled: 'Deshabilitado',
    tab_run: 'Ejecutar',
    tab_reports: 'Reportes',
    tab_watch: 'Monitoreo',
    packetLoss: 'Pérdida de paquetes',
  },
  'es-MX': { tab_watch: 'Monitoreo', tab_reports: 'Reportes', delete: 'Borrar' },
  'es-AR': { tab_watch: 'Monitoreo', tab_reports: 'Reportes', delete: 'Eliminar', add: 'Agregar' },
  'pt-PT': {
    appSub: 'Inteligência VTuber local',
    tab_intel: 'Informação',
    tab_run: 'Executar',
    tab_sources: 'Fontes',
    tab_watch: 'Vigilância',
    tab_settings: 'Definições',
    tab_reports: 'Relatórios',
    tab_live: 'Em direto',
    tab_search: 'Pesquisar',
    save: 'Guardar',
    saving: 'A guardar…',
    saved: 'Guardado',
    saveStateIdle: 'Ainda sem alterações',
    saveStateDirty: 'Alterações por guardar',
    delete: 'Eliminar',
    cancel: 'Cancelar',
    add: 'Adicionar',
    refresh: 'Atualizar',
    probe: 'Testar ligação',
    loading: 'A carregar…',
    error: 'Erro',
    enabled: 'Ativado',
    disabled: 'Desativado',
    name: 'Nome',
    time: 'Hora',
    date: 'Data',
    language: 'Idioma',
    proxy: 'Proxy',
    direct: 'Ligação direta',
    auto: 'Automático',
    latency: 'Latência',
    packetLoss: 'Perda de pacotes',
  },
  'pt-BR': {
    // Brazilian Portuguese's real differences
    tab_settings: 'Configurações',
    tab_live: 'Ao vivo',
    tab_search: 'Pesquisar',
    save: 'Salvar',
    saving: 'Salvando…',
    saved: 'Salvo',
    saveStateIdle: 'Ainda sem alterações',
    saveStateDirty: 'Alterações não salvas',
    delete: 'Excluir',
    refresh: 'Atualizar',
    probe: 'Testar conexão',
    loading: 'Carregando…',
    enabled: 'Ativado',
    disabled: 'Desativado',
    direct: 'Conexão direta',
    auto: 'Automático',
  },
  'fr-FR': {
    appSub: 'Renseignement VTuber local',
    tab_intel: 'Infos',
    tab_run: 'Exécuter',
    tab_sources: 'Sources',
    tab_watch: 'Surveillance',
    tab_settings: 'Paramètres',
    tab_reports: 'Rapports',
    tab_live: 'En direct',
    tab_search: 'Rechercher',
    save: 'Enregistrer',
    saving: 'Enregistrement…',
    saved: 'Enregistré',
    saveStateIdle: 'Aucune modification',
    saveStateDirty: 'Modifications non enregistrées',
    delete: 'Supprimer',
    cancel: 'Annuler',
    add: 'Ajouter',
    refresh: 'Actualiser',
    probe: 'Tester la connexion',
    loading: 'Chargement…',
    error: 'Erreur',
    yes: 'Oui',
    no: 'Non',
    enabled: 'Activé',
    disabled: 'Désactivé',
    name: 'Nom',
    time: 'Heure',
    date: 'Date',
    language: 'Langue',
    proxy: 'Proxy',
    direct: 'Connexion directe',
    auto: 'Automatique',
    latency: 'Latence',
    packetLoss: 'Perte de paquets',
  },
  'de-DE': {
    appSub: 'Lokale VTuber-Aufklärung',
    tab_intel: 'Informationen',
    tab_run: 'Ausführen',
    tab_sources: 'Quellen',
    tab_watch: 'Überwachung',
    tab_settings: 'Einstellungen',
    tab_reports: 'Berichte',
    tab_live: 'Live',
    tab_search: 'Suche',
    save: 'Speichern',
    saving: 'Speichern…',
    saved: 'Gespeichert',
    saveStateIdle: 'Noch keine Änderungen',
    saveStateDirty: 'Ungespeicherte Änderungen',
    delete: 'Löschen',
    cancel: 'Abbrechen',
    add: 'Hinzufügen',
    refresh: 'Aktualisieren',
    probe: 'Verbindung testen',
    loading: 'Wird geladen…',
    error: 'Fehler',
    yes: 'Ja',
    no: 'Nein',
    enabled: 'Aktiviert',
    disabled: 'Deaktiviert',
    name: 'Name',
    time: 'Uhrzeit',
    date: 'Datum',
    language: 'Sprache',
    proxy: 'Proxy',
    direct: 'Direktverbindung',
    auto: 'Automatisch',
    latency: 'Latenz',
    packetLoss: 'Paketverlust',
  },
  'it-IT': {
    appSub: 'Intelligence VTuber locale',
    tab_intel: 'Informazioni',
    tab_run: 'Esegui',
    tab_sources: 'Fonti',
    tab_watch: 'Monitoraggio',
    tab_settings: 'Impostazioni',
    tab_reports: 'Report',
    tab_live: 'In diretta',
    tab_search: 'Cerca',
    save: 'Salva',
    saving: 'Salvataggio…',
    saved: 'Salvato',
    saveStateDirty: 'Modifiche non salvate',
    delete: 'Elimina',
    cancel: 'Annulla',
    add: 'Aggiungi',
    refresh: 'Aggiorna',
    probe: 'Verifica connessione',
    loading: 'Caricamento…',
    error: 'Errore',
    yes: 'Sì',
    no: 'No',
    enabled: 'Attivo',
    disabled: 'Disattivo',
    name: 'Nome',
    time: 'Ora',
    date: 'Data',
    language: 'Lingua',
    direct: 'Connessione diretta',
    auto: 'Automatico',
    latency: 'Latenza',
    packetLoss: 'Perdita di pacchetti',
  },
  'ru-RU': {
    appSub: 'Локальная разведка VTuber',
    tab_intel: 'Сводка',
    tab_run: 'Запуск',
    tab_sources: 'Источники',
    tab_watch: 'Наблюдение',
    tab_settings: 'Настройки',
    tab_reports: 'Отчёты',
    tab_live: 'Эфир',
    tab_search: 'Поиск',
    save: 'Сохранить',
    saving: 'Сохранение…',
    saved: 'Сохранено',
    saveStateIdle: 'Изменений пока нет',
    saveStateDirty: 'Есть несохранённые изменения',
    delete: 'Удалить',
    cancel: 'Отмена',
    add: 'Добавить',
    refresh: 'Обновить',
    probe: 'Проверить связь',
    loading: 'Загрузка…',
    error: 'Ошибка',
    yes: 'Да',
    no: 'Нет',
    enabled: 'Включено',
    disabled: 'Выключено',
    name: 'Название',
    time: 'Время',
    date: 'Дата',
    language: 'Язык',
    proxy: 'Прокси',
    direct: 'Прямое подключение',
    auto: 'Автоматически',
    latency: 'Задержка',
    packetLoss: 'Потери пакетов',
  },
  'uk-UA': {
    // Ukrainian is an independent language, not a dialect of Russian - cross-language fallback is
    // already disabled in i18n.jsx's usableChain (otherwise the UI would show Russian). So this
    // level has to exist on its own here.
    saveStateIdle: 'Змін поки немає',
    saveStateDirty: 'Є незбережені зміни',
    cancel: 'Скасувати',
    refresh: 'Оновити',
    loading: 'Завантаження…',
    error: 'Помилка',
    yes: 'Так',
    no: 'Ні',
    enabled: 'Увімкнено',
    disabled: 'Вимкнено',
    date: 'Дата',
    source: 'Джерело',
    sources: 'Джерела',
    searchTitle: 'Пошук у зведенні',
    reportsTitle: 'Звіти',
    eventsTitle: 'Об’єднані події',
    chartsTitle: 'Графіки динаміки',
    shareTitle: 'Поділитися',
    shareDownload: 'Створити й завантажити',
    shareCopy: 'Копіювати текст',
    intelTitle: 'Картки зведення',
    runTitle: 'Запустити збір',
    done: 'Готово',
    failed: 'Не вдалося',
    alerts: 'Сповіщення',
    noItems: 'Зведення поки немає',
    onlyAlerts: 'Лише сповіщення',
    onlyStarred: 'Лише обрані',
    onlyUnread: 'Лише непрочитані',
    mergeEvents: 'Об’єднувати дублікати подій',
    save: 'Зберегти',
    saving: 'Збереження…',
    saved: 'Збережено',
    add: 'Додати',
    delete: 'Видалити',
    name: 'Назва',
    time: 'Час',
    language: 'Мова',
    tab_intel: 'Зведення',
    tab_run: 'Запуск',
    tab_sources: 'Джерела',
    tab_watch: 'Спостереження',
    tab_settings: 'Налаштування',
    tab_reports: 'Звіти',
    tab_live: 'Ефір',
    tab_search: 'Пошук',
    save: 'Зберегти',
    saving: 'Збереження…',
    saved: 'Збережено',
    delete: 'Видалити',
    cancel: 'Скасувати',
    add: 'Додати',
    refresh: 'Оновити',
    loading: 'Завантаження…',
    error: 'Помилка',
    yes: 'Так',
    no: 'Ні',
    enabled: 'Увімкнено',
    disabled: 'Вимкнено',
    name: 'Назва',
    language: 'Мова',
    direct: 'Пряме підключення',
    auto: 'Автоматично',
    latency: 'Затримка',
  },
  'pl-PL': {
    saveStateIdle: 'Brak zmian',
    saveStateDirty: 'Niezapisane zmiany',
    cancel: 'Anuluj',
    refresh: 'Odśwież',
    loading: 'Ładowanie…',
    error: 'Błąd',
    yes: 'Tak',
    no: 'Nie',
    enabled: 'Włączone',
    disabled: 'Wyłączone',
    date: 'Data',
    source: 'Źródło',
    sources: 'Źródła',
    searchTitle: 'Wyszukiwanie informacji',
    reportsTitle: 'Raporty',
    eventsTitle: 'Połączone zdarzenia',
    chartsTitle: 'Wykresy trendów',
    shareTitle: 'Udostępnij',
    shareDownload: 'Utwórz i pobierz',
    shareCopy: 'Kopiuj tekst',
    intelTitle: 'Karty informacji',
    runTitle: 'Uruchom zbieranie',
    done: 'Gotowe',
    failed: 'Nie udało się',
    alerts: 'Alerty',
    noItems: 'Brak informacji',
    onlyAlerts: 'Tylko alerty',
    onlyStarred: 'Tylko oznaczone',
    onlyUnread: 'Tylko nieprzeczytane',
    mergeEvents: 'Scalaj zduplikowane zdarzenia',
    save: 'Zapisz',
    saving: 'Zapisywanie…',
    saved: 'Zapisano',
    add: 'Dodaj',
    delete: 'Usuń',
    name: 'Nazwa',
    time: 'Godzina',
    language: 'Język',
    tab_intel: 'Informacje',
    tab_run: 'Uruchom',
    tab_sources: 'Źródła',
    tab_watch: 'Obserwacja',
    tab_settings: 'Ustawienia',
    tab_reports: 'Raporty',
    tab_live: 'Na żywo',
    tab_search: 'Szukaj',
    save: 'Zapisz',
    saving: 'Zapisywanie…',
    saved: 'Zapisano',
    delete: 'Usuń',
    cancel: 'Anuluj',
    add: 'Dodaj',
    refresh: 'Odśwież',
    loading: 'Ładowanie…',
    error: 'Błąd',
    yes: 'Tak',
    no: 'Nie',
    enabled: 'Włączone',
    disabled: 'Wyłączone',
    name: 'Nazwa',
    language: 'Język',
    direct: 'Połączenie bezpośrednie',
    auto: 'Automatycznie',
    latency: 'Opóźnienie',
  },
  'sr-RS': {
    saveStateIdle: 'Још нема измена',
    saveStateDirty: 'Има несачуваних измена',
    cancel: 'Откажи',
    refresh: 'Освежи',
    loading: 'Учитавање…',
    error: 'Грешка',
    yes: 'Да',
    no: 'Не',
    enabled: 'Укључено',
    disabled: 'Искључено',
    date: 'Датум',
    source: 'Извор',
    sources: 'Извори',
    searchTitle: 'Претрага информација',
    reportsTitle: 'Извештаји',
    eventsTitle: 'Обједињени догађаји',
    chartsTitle: 'Графици трендова',
    shareTitle: 'Подели',
    shareDownload: 'Направи и преузми',
    shareCopy: 'Копирај текст',
    intelTitle: 'Картице информација',
    runTitle: 'Покрени прикупљање',
    done: 'Готово',
    failed: 'Није успело',
    alerts: 'Упозорења',
    noItems: 'Још нема информација',
    onlyAlerts: 'Само упозорења',
    onlyStarred: 'Само означено',
    onlyUnread: 'Само непрочитано',
    mergeEvents: 'Обједини дупликате догађаја',
    save: 'Сачувај',
    saving: 'Чување…',
    saved: 'Сачувано',
    add: 'Додај',
    delete: 'Обриши',
    name: 'Назив',
    time: 'Време',
    language: 'Језик',
    tab_intel: 'Информације',
    tab_run: 'Покрени',
    tab_sources: 'Извори',
    tab_settings: 'Подешавања',
    tab_reports: 'Извештаји',
    save: 'Сачувај',
    saving: 'Чување…',
    saved: 'Сачувано',
    delete: 'Обриши',
    cancel: 'Откажи',
    add: 'Додај',
    refresh: 'Освежи',
    loading: 'Учитавање…',
    error: 'Грешка',
    yes: 'Да',
    no: 'Не',
    enabled: 'Укључено',
    disabled: 'Искључено',
    name: 'Назив',
    language: 'Језик',
    auto: 'Аутоматски',
  },
  'pt-PT': {
    saveStateIdle: 'Ainda sem alterações',
    saveStateDirty: 'Alterações por guardar',
    cancel: 'Cancelar',
    refresh: 'Atualizar',
    loading: 'A carregar…',
    error: 'Erro',
    yes: 'Sim',
    no: 'Não',
    enabled: 'Ativado',
    disabled: 'Desativado',
    date: 'Data',
    source: 'Fonte',
    sources: 'Fontes',
    searchTitle: 'Pesquisa de informação',
    reportsTitle: 'Relatórios',
    eventsTitle: 'Eventos fundidos',
    chartsTitle: 'Gráficos de tendência',
    shareTitle: 'Partilhar',
    shareDownload: 'Gerar e transferir',
    shareCopy: 'Copiar texto',
    intelTitle: 'Cartões de informação',
    runTitle: 'Executar recolha',
    done: 'Concluído',
    failed: 'Falhou',
    alerts: 'Alertas',
    noItems: 'Ainda não há informação',
    onlyAlerts: 'Só alertas',
    onlyStarred: 'Só favoritos',
    onlyUnread: 'Só não lidos',
    mergeEvents: 'Fundir eventos duplicados',
    packetLoss: 'Perda de pacotes',
    save: 'Guardar',
    saving: 'A guardar…',
    saved: 'Guardado',
    add: 'Adicionar',
    delete: 'Eliminar',
    name: 'Nome',
    time: 'Hora',
    language: 'Idioma',
    latency: 'Latência',
  },
  'ar-SA': {
    // RTL: the whole-page direction is driven by dir:'rtl' in LOCALES
    appSub: 'استخبارات VTuber محلية',
    tab_intel: 'المعلومات',
    tab_run: 'تشغيل',
    tab_sources: 'المصادر',
    tab_watch: 'المراقبة',
    tab_settings: 'الإعدادات',
    tab_reports: 'التقارير',
    tab_live: 'البث',
    tab_search: 'بحث',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    saveStateIdle: 'لا تغييرات بعد',
    saveStateDirty: 'تغييرات غير محفوظة',
    delete: 'حذف',
    cancel: 'إلغاء',
    add: 'إضافة',
    refresh: 'تحديث',
    probe: 'اختبار الاتصال',
    loading: 'جارٍ التحميل…',
    error: 'خطأ',
    yes: 'نعم',
    no: 'لا',
    enabled: 'مُفعّل',
    disabled: 'مُعطّل',
    name: 'الاسم',
    time: 'الوقت',
    date: 'التاريخ',
    language: 'اللغة',
    proxy: 'وكيل',
    direct: 'اتصال مباشر',
    auto: 'تلقائي',
    latency: 'زمن الاستجابة',
    packetLoss: 'فقدان الحزم',
  },
  'id-ID': {
    // Indonesian is an independent language with its own chain (['id-ID','en-US']), so this level
    // has to exist on its own; nothing here is inherited from another locale.
    appSub: 'Intelijen VTuber lokal',
    tab_intel: 'Intel',
    tab_run: 'Jalankan',
    tab_sources: 'Sumber',
    tab_watch: 'Pantau',
    tab_settings: 'Pengaturan',
    tab_reports: 'Laporan',
    tab_live: 'Siaran',
    tab_search: 'Cari',
    tab_llm: 'LLM',
    save: 'Simpan',
    saving: 'Menyimpan…',
    saved: 'Tersimpan',
    saveStateIdle: 'Belum ada perubahan',
    saveStateDirty: 'Ada perubahan yang belum disimpan',
    delete: 'Hapus',
    cancel: 'Batal',
    add: 'Tambah',
    refresh: 'Muat ulang',
    probe: 'Uji koneksi',
    loading: 'Memuat…',
    error: 'Galat',
    yes: 'Ya',
    no: 'Tidak',
    enabled: 'Aktif',
    disabled: 'Nonaktif',
    name: 'Nama',
    time: 'Waktu',
    date: 'Tanggal',
    language: 'Bahasa',
    proxy: 'Proksi',
    direct: 'Koneksi langsung',
    auto: 'Otomatis',
    latency: 'Latensi',
    packetLoss: 'Kehilangan paket',
  },
  'fil-PH': {
    // Same reasoning as the Indonesian level above: Filipino is an independent language with its own
    // chain (['fil-PH','en-US']), so this level stands alone and inherits nothing from another locale.
    appSub: 'Lokal na intelihensiya ng VTuber',
    tab_intel: 'Impormasyon',
    tab_run: 'Magpatakbo',
    tab_sources: 'Pinagmulan',
    tab_watch: 'Subaybayan',
    tab_settings: 'Mga setting',
    tab_reports: 'Mga ulat',
    tab_live: 'Live',
    tab_search: 'Maghanap',
    tab_llm: 'LLM',
  },
  'th-TH': {
    // Same reasoning again: Thai is an independent language with its own chain
    // (['th-TH','en-US']), so this level stands alone and inherits nothing from another locale.
    //
    // These nine labels are the tab row, the first thing the Thai UI shows, and they are the anchor
    // the traversal check at the end of tools/traverse-ui.cjs asserts against: a locale that is
    // registered in LOCALES but whose layers never landed still "works" -- it silently shows the
    // English fallback -- and only reading the rendered page out reveals it.
    //
    // `tab_live` is the word Thai actually says for a live stream (ไลฟ์), not a transliteration of
    // "Live"; the same word is used inside liveHint above and in the traversal's hint assertion, so
    // a regression to English cannot pass by matching a borrowed word.
    appSub: 'ศูนย์ข่าวกรอง VTuber ในเครื่อง',
    tab_intel: 'ข้อมูล',
    tab_run: 'เรียกเก็บข้อมูล',
    tab_sources: 'แหล่งข้อมูล',
    tab_watch: 'เฝ้าติดตาม',
    tab_settings: 'การตั้งค่า',
    tab_reports: 'รายงาน',
    tab_live: 'ไลฟ์',
    tab_search: 'ค้นหา',
    tab_llm: 'LLM',
  },
  'vi-VN': {
    // Same reasoning again: Vietnamese is an independent language with its own chain
    // (['vi-VN','en-US']), so this level stands alone and inherits nothing from another locale.
    //
    // These nine labels are the tab row, the first thing the Vietnamese UI shows, and they are the
    // anchor the traversal check at the end of tools/traverse-ui.cjs asserts against: a locale that is
    // registered in LOCALES but whose layers never landed still "works" -- it silently shows the
    // English fallback -- and only reading the rendered page out reveals it. (The other two tabs,
    // People and Calendar, are in LATE_KEYS above.)
    //
    // `tab_live` is the phrase Vietnamese actually says for a live stream (Phát trực tiếp), not a
    // borrowed "Live"; the same phrase starts the hand-written liveHint above and appears in the
    // traversal's hint assertion, so a regression to English cannot pass by matching a borrowed word.
    // The nine labels carry a capital at the front, which is how a standalone Vietnamese label is
    // written -- the count-label base values above are lower case for the opposite reason.
    appSub: 'Trung tâm thông tin VTuber cục bộ',
    tab_intel: 'Thông tin',
    tab_run: 'Chạy',
    tab_sources: 'Nguồn',
    tab_watch: 'Theo dõi',
    tab_settings: 'Cài đặt',
    tab_reports: 'Báo cáo',
    tab_live: 'Phát trực tiếp',
    tab_search: 'Tìm kiếm',
    tab_llm: 'LLM',
  },
};

// Merge the "UI elements added later" entries in one place at the end (it must sit after the
// HAND_COMMON declaration, see the comment above)
for (const [code, dict] of Object.entries(LATE_KEYS)) {
  HAND_COMMON[code] = { ...(HAND_COMMON[code] ?? {}), ...dict };
}

/**
 * A one-time repair of a translation defect the guards now catch (BUGS #75).
 *
 * `cookieCount` is "{n} 个" and the machine pass returned a bare "{n}" in fourteen locales: the noun
 * was dropped, and every gate the pipeline had passed it - the placeholder was intact, there were no
 * Han characters left, and no length rule fires on something that short. The UI rendered a number with
 * nothing after it. It was found by hand in the Indonesian locale, and then by the new count-label
 * guard in the other thirteen. (english-logic:allow - the Chinese source string is the subject of the
 * sentence; that is what the escape hatch is for, see docs/ENGLISH-LOGIC.md section 3.)
 *
 * Hand-written rather than sent through the pipeline again, for the reason this file exists at all:
 * this is a wording decision, and a machine pass that dropped the noun once can drop it again.
 */
const COUNT_LABEL_REPAIR = {
  'es-ES': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'es-419': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'es-MX': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'es-AR': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'pt-PT': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'pt-BR': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (incl. SESSDATA)' },
  'fr-FR': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (SESSDATA incluse)' },
  'fr-CA': { cookieCount: '{n} cookies', cookieCountWithSession: '{n} cookies (SESSDATA incluse)' },
  'de-DE': { cookieCount: '{n} Cookies', cookieCountWithSession: '{n} Cookies (inkl. SESSDATA)' },
  'it-IT': { cookieCount: '{n} cookie', cookieCountWithSession: '{n} cookie (incl. SESSDATA)' },
  'uk-UA': { cookieCount: '{n} кукі', cookieCountWithSession: '{n} кукі (разом із SESSDATA)' },
  'sr-RS': { cookieCount: '{n} колачића', cookieCountWithSession: '{n} колачића (укључујући SESSDATA)' },
  'pl-PL': { cookieCount: '{n} ciasteczek', cookieCountWithSession: '{n} ciasteczek (w tym SESSDATA)' },
  'ar-SA': { cookieCount: '{n} ملفات تعريف الارتباط', cookieCountWithSession: '{n} ملفات تعريف الارتباط (بما في ذلك SESSDATA)' },
};

for (const [code, dict] of Object.entries(COUNT_LABEL_REPAIR)) {
  HAND_COMMON[code] = { ...(HAND_COMMON[code] ?? {}), ...dict };
}
