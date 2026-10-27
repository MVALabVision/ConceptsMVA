# MVA Lab — Concept Studio

Website tĩnh trên GitHub Pages để lưu trữ, xuất bản và chia sẻ các concept 3D (HTML / Three.js / WebGL) của MVA Lab cho khách hàng.

- **Website quản lý:** https://mvalabvision.github.io/ConceptsMVA/
- **Link concept:** `https://mvalabvision.github.io/ConceptsMVA/concepts/<slug>/`
  (ví dụ: https://mvalabvision.github.io/ConceptsMVA/concepts/tram-pas-hfs-vina/)
- **Repository:** https://github.com/MVALabVision/ConceptsMVA

Khách hàng chỉ cần mở link trên trình duyệt — không cần đăng nhập, không cần cài phần mềm.

---

## 1. Kiến trúc

```
Trình duyệt quản trị                    GitHub                         Khách hàng
┌─────────────────────┐   REST API   ┌──────────────────────┐          ┌───────────┐
│ index.html (admin)  │ ───────────► │ repo ConceptsMVA      │          │ Trình     │
│ • chọn HTML / ZIP   │  1 commit    │  concepts/<slug>/…    │          │ duyệt     │
│ • kiểm tra gói      │  (Git Data   │  data/concepts.json   │          │ mở link   │
│ • token trong       │   API)       └──────────┬───────────┘          └─────▲─────┘
│   trình duyệt       │                         │ push → GitHub Actions       │
│ • chờ deploy xong   │ ◄── data/build.json ─── │ deploy.yml → GitHub Pages ──┘
└─────────────────────┘                         └────────────────────────────
```

- **Hosting:** GitHub Pages (HTTPS), deploy bằng GitHub Actions (`.github/workflows/deploy.yml`).
- **Frontend:** HTML/CSS/JS thuần (ES modules), không cần bước build.
- **Dữ liệu:** `data/concepts.json` là danh sách concept; file của từng concept nằm trong `concepts/<slug>/`.
- **Xuất bản:** trình duyệt của quản trị viên gọi GitHub REST API (Git Data API) để tạo **một commit duy nhất** chứa cả file concept lẫn `concepts.json` cập nhật, sau đó GitHub Actions deploy. Giao diện chỉ báo "Published" khi `data/build.json` trên site trùng với commit vừa tạo.
- **Xác thực:** quản trị viên đăng nhập bằng **fine-grained personal access token** của GitHub. Token chỉ nằm trong trình duyệt (sessionStorage, hoặc localStorage nếu chọn "ghi nhớ"), chỉ được gửi tới `api.github.com`, **không bao giờ** nằm trong mã nguồn hay repository.

Vì sao không dùng OAuth/backend? GitHub Pages không có server, nên mọi phương án đều cần hoặc (a) một backend riêng giữ secret, hoặc (b) token của chính quản trị viên trong trình duyệt. Phương án (b) đơn giản, không tốn chi phí, không có secret nào trong repo và vẫn tách biệt rõ quản trị/công khai. Mục 9 mô tả cách nâng cấp lên (a) nếu cần.

## 2. Cấu trúc repository

```
ConceptsMVA/
├── index.html                 # Giao diện: thư viện công khai + chế độ quản trị
├── preview.html               # Trang host xem thử (chạy trong iframe sandbox)
├── 404.html                   # Trang báo link không tồn tại
├── assets/
│   ├── css/app.css
│   ├── js/
│   │   ├── config.js          # owner/repo/branch, giới hạn dung lượng (không có secret)
│   │   ├── app.js             # Logic giao diện
│   │   ├── github.js          # GitHub API: publish / replace / delete / chờ deploy
│   │   ├── package.js         # Đọc & kiểm tra HTML/ZIP (path traversal, giới hạn, tham chiếu)
│   │   ├── i18n.js            # Chuỗi giao diện EN/VI
│   │   ├── slug.js            # Tạo slug (hỗ trợ tiếng Việt)
│   │   └── util.js
│   ├── img/                   # logo, favicon
│   └── vendor/jszip.min.js    # Đọc ZIP phía trình duyệt (self-host, không CDN)
├── concepts/
│   └── tram-pas-hfs-vina/index.html
├── data/
│   ├── concepts.json          # Danh sách concept (metadata)
│   └── thumbs/<slug>.jpg      # Thumbnail (tùy chọn)
├── tools/
│   ├── validate.mjs           # Kiểm tra concepts.json ↔ thư mục concepts/ (chạy trong CI)
│   └── test.mjs               # Unit/integration test chạy bằng Node
├── .github/workflows/deploy.yml
├── .nojekyll
└── README.md
```

Định dạng một mục trong `data/concepts.json`:

```json
{
  "slug": "shinyei-drop-test-vision",
  "name": "SHINYEI Drop Test Vision",
  "project": "SHINYEI",
  "description": "Mô tả ngắn cho khách hàng",
  "entry": "index.html",
  "source": "zip",
  "status": "published",
  "version": 2,
  "files": 14,
  "bytes": 4823110,
  "createdAt": "2026-10-27T03:10:00.000Z",
  "updatedAt": "2026-10-28T08:00:00.000Z",
  "thumbnail": "data/thumbs/shinyei-drop-test-vision.jpg"
}
```

## 3. Thiết lập lần đầu

### 3.1 Bật GitHub Pages (một lần)

Workflow tự thử bật Pages ở lần chạy đầu. Nếu job `deploy` báo lỗi "Pages not enabled" hoặc tương tự:

1. Vào **Settings → Pages** của repository.
2. Mục **Build and deployment → Source**, chọn **GitHub Actions**.
3. Vào tab **Actions**, chạy lại workflow *Deploy Concept Studio to GitHub Pages* (nút *Re-run jobs*).

Sau khi deploy xong, website nằm tại https://mvalabvision.github.io/ConceptsMVA/.

### 3.2 Tạo token cho quản trị viên

1. Mở https://github.com/settings/personal-access-tokens/new (tài khoản phải là thành viên có quyền ghi vào repo).
2. **Token name:** `ConceptsMVA Concept Studio`. **Expiration:** tối đa 1 năm (hết hạn thì tạo lại).
3. **Resource owner:** chọn **MVALabVision** (tổ chức), không phải tài khoản cá nhân.
4. **Repository access:** *Only select repositories* → `ConceptsMVA`.
5. **Permissions → Repository permissions:**
   - **Contents:** Read and write (bắt buộc)
   - **Actions:** Read (để theo dõi trạng thái deploy)
   - *Metadata: Read* được thêm tự động.
6. Generate token, copy chuỗi `github_pat_…` và cất trong trình quản lý mật khẩu.

Nếu tổ chức chưa cho phép fine-grained token: **Organization settings → Third-party Access → Personal access tokens → Fine-grained tokens → Allow access** (và tắt yêu cầu phê duyệt, hoặc phê duyệt token khi được hỏi). Phương án dự phòng là classic token với scope `repo`, nhưng token đó có quyền rộng hơn — không khuyến khích.

### 3.3 Đăng nhập

Trên website bấm **Admin sign in**, dán token, bấm **Sign in**. Hệ thống kiểm tra token có quyền `push` vào repo rồi mới mở chức năng quản trị.

- Mặc định token chỉ lưu trong tab hiện tại (đóng tab là đăng xuất).
- Tick **Remember on this device** để lưu trong trình duyệt của máy đó. Chỉ bật trên máy tin cậy (xem mục 7).

## 4. Sử dụng hằng ngày

### Upload concept mới
1. **Upload New Concept**.
2. Nhập **tên concept** (bắt buộc), **dự án**, **mô tả**.
3. Chọn file **.html** (độc lập) hoặc **.zip** (HTML + tài nguyên). Có thể kéo thả.
4. Hệ thống đọc gói, liệt kê file, cảnh báo nếu thiếu tài nguyên tương đối, dùng `http://`, sai hoa/thường, v.v.
   Với ZIP, chọn **Entry HTML file** nếu gói có nhiều file HTML.
5. **Slug** tự tạo từ tên (`Trạm PAS HFS VINA` → `tram-pas-hfs-vina`); sửa được. Hệ thống kiểm tra trùng slug trong danh sách và trong repo.
6. (Tùy chọn) chọn ảnh **thumbnail** và bấm **Preview** để xem thử trong sandbox.
7. **Publish**. Hộp tiến trình hiển thị: Validating → Uploading → Commit → Deploying → Verifying.
8. Khi deploy xong, hiện **link công khai**, nút **Copy Link** và **Open Concept**.

Nếu commit thành công nhưng deploy lỗi, hộp kết quả báo rõ "Deployment failed" kèm link tới workflow run — không báo thành công giả. Nếu quá 8 phút chưa xong, hộp báo "still pending" cùng link để theo dõi.

### Gửi link cho khách hàng
Bấm **Copy Link** trên card (hoặc trong hộp kết quả) rồi dán vào Zalo/email. **View Concept** mở concept trong tab mới.

### Cập nhật concept nhưng giữ nguyên link — *Replace Version*
Trên card bấm **Replace Version**, chọn file HTML/ZIP mới, Publish. Toàn bộ thư mục `concepts/<slug>/` được thay bằng bộ file mới trong cùng một commit; `version` tăng, slug và link **không đổi**. Nếu chọn entry khác `index.html`, giao diện cảnh báo link sẽ thay đổi.

### Sửa tên, dự án, mô tả, thumbnail, trạng thái — *Edit Details*
Chỉ thay đổi metadata trong `concepts.json` (và thumbnail nếu chọn). **Status: Archived** ẩn concept khỏi thư viện công khai nhưng link vẫn hoạt động — dùng khi muốn "cất" mà không làm hỏng link đã gửi.

### Xóa — *Delete*
Yêu cầu gõ lại slug để xác nhận. Thư mục concept, thumbnail và mục trong `concepts.json` bị xóa trong một commit; link ngừng hoạt động sau khi deploy. Có thể khôi phục từ lịch sử Git (mục 6).

### Giao diện
- **EN / Tiếng Việt**: nút chuyển ngôn ngữ ở góc phải.
- **Sáng / tối**: theo hệ điều hành, có nút đổi thủ công.
- **Help**: hướng dẫn ngắn ngay trên trang cho người xem và quản trị viên.

## 5. Yêu cầu với file concept

Hệ thống **giữ nguyên** mọi file: không sửa HTML/CSS/JS, không đổi tên, không đổi đường dẫn. Vì vậy concept phải tự chạy được khi đặt trong thư mục `concepts/<slug>/`:

| Trường hợp | Cách upload | Lưu ý |
|---|---|---|
| Một file HTML dùng CDN (Three.js, Google Fonts…) | `.html` | Chạy ngay. CDN giữ nguyên. |
| HTML + model/texture/css/js cục bộ | `.zip` chứa `index.html` ở gốc (hoặc trong 1 thư mục gốc chung) | Đường dẫn trong HTML phải **tương đối** (`assets/x.glb`, `./js/app.js`), **không** bắt đầu bằng `/`. |
| Tài nguyên `http://` | — | Bị trình duyệt chặn trên HTTPS (mixed content). Đổi sang `https://` trước khi upload. |
| Tham chiếu `file:///C:/…` | — | Không chạy được khi online. |
| Tên file sai hoa/thường (`Logo.PNG` vs `logo.png`) | — | GitHub Pages phân biệt hoa thường; giao diện cảnh báo. |
| Cần server riêng (API nội bộ, WebSocket, PHP…) | — | GitHub Pages chỉ phục vụ file tĩnh. |

Giới hạn mặc định (sửa trong `assets/js/config.js`): file upload ≤ 30 MB, mỗi file trong ZIP ≤ 25 MB, tổng sau giải nén ≤ 80 MB, ≤ 1500 file. GitHub Pages giới hạn site 1 GB và mỗi file 100 MB.

ZIP được kiểm tra: từ chối đường dẫn `..`, đường dẫn tuyệt đối, ổ đĩa `C:`, symlink, thư mục `.git`; bỏ qua `__MACOSX`, `.DS_Store`, `Thumbs.db`; chặn zip-bomb bằng giới hạn dung lượng khi giải nén.

## 6. Khôi phục và thao tác Git thủ công

Mọi thay đổi là một commit trên nhánh `main`, nên có thể quay lại bất cứ lúc nào.

```bash
git clone https://github.com/MVALabVision/ConceptsMVA.git
cd ConceptsMVA

# Xem lịch sử một concept
git log --oneline -- concepts/shinyei-drop-test-vision data/concepts.json

# Hoàn tác commit gần nhất (ví dụ xóa nhầm) — tạo commit đảo ngược, không mất lịch sử
git revert HEAD
git push

# Khôi phục một concept đã xóa từ commit trước khi xóa (<sha> = commit "concept: delete …")
git checkout <sha>^ -- concepts/<slug> data/concepts.json
git commit -m "restore <slug>"
git push

# Quay về đúng phiên bản cũ của một concept (Replace nhầm)
git checkout <sha-cua-phien-ban-cu> -- concepts/<slug>
git commit -m "rollback <slug>"
git push
```

Thêm concept bằng Git (không qua giao diện): chép file vào `concepts/<slug>/`, thêm mục tương ứng vào `data/concepts.json`, chạy `node tools/validate.mjs` để kiểm tra, rồi commit & push. Workflow sẽ deploy như bình thường. Thư mục có trong `concepts/` nhưng không có trong `concepts.json` vẫn được deploy (link vẫn mở được) nhưng không hiện trong thư viện.

## 7. Bảo mật

- **Phân tách quyền:** người xem chỉ đọc `data/concepts.json` và mở trang concept. Chỉ người có token với quyền `Contents: write` mới upload/sửa/xóa — kiểm tra ở GitHub, không phải ở frontend.
- **Không có secret trong repo:** `config.js` chỉ chứa owner/repo/branch. Token do quản trị viên nhập và nằm trong trình duyệt.
- **Lưu token ở đâu?** Mặc định `sessionStorage` (chỉ tab hiện tại; concept mở ở tab mới qua `rel="noopener"` không đọc được). Chọn "Remember on this device" sẽ lưu `localStorage` — khi đó **mọi trang cùng origin** (kể cả concept HTML đã upload, vì cùng `mvalabvision.github.io`) về lý thuyết có thể đọc token. Chỉ bật trên máy tin cậy và chỉ upload concept do chính bạn tạo. Nếu nghi ngờ lộ token: vào GitHub → Settings → Personal access tokens → Revoke.
- **Preview cô lập:** xem thử chạy trong `preview.html` nằm trong iframe `sandbox="allow-scripts"` (origin opaque, không storage, không cookie, không đọc được trang quản trị), bên trong lại là iframe `srcdoc` sandbox nữa. WebGL/Three.js vẫn chạy.
- **Không `innerHTML`:** mọi metadata (tên, mô tả…) được render bằng `textContent`. Trang quản trị có **Content-Security-Policy** chỉ cho phép script cùng origin, kết nối tới `api.github.com`, font từ Google Fonts.
- **Thư viện ngoài:** JSZip được self-host trong `assets/vendor/` (không phụ thuộc CDN, nằm trong CSP).
- **Concept là HTML tùy ý:** chỉ quản trị viên xuất bản được. Concept được mở trong tab riêng (không nhúng vào trang quản trị).
- **Workflow:** chỉ có quyền `contents: read`, `pages: write`, `id-token: write`; không dùng secret nào.

## 8. Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| "Deployment failed" ngay lần đầu | Pages chưa bật → mục 3.1, rồi *Re-run jobs*. |
| Token bị từ chối (401) | Token sai/hết hạn. Tạo lại. |
| "does not have write access" | Resource owner không phải MVALabVision, hoặc chưa cấp `Contents: Read and write`, hoặc tổ chức chưa phê duyệt token. |
| Rate limit (403) | Token có 5.000 request/giờ; chờ theo thời gian báo. |
| Link mở ra 404 ngay sau khi "Published" | CDN của GitHub Pages có thể trễ ~1 phút. Tải lại. Nếu kéo dài, kiểm tra tab Actions. |
| Concept trắng trang / lỗi console | Mở DevTools (F12) → Console. Thường do đường dẫn tuyệt đối `/assets/…`, tài nguyên `http://`, hoặc thiếu file (giao diện đã cảnh báo lúc upload). |
| "Repository changed meanwhile — retrying" | Có người khác vừa commit; hệ thống tự thử lại tối đa 3 lần. |
| Actions bị tắt | Settings → Actions → General → Allow all actions. |
| Workflow validate báo lỗi | Chạy `node tools/validate.mjs` cục bộ, sửa `data/concepts.json`. |

Lệnh kiểm tra cục bộ:

```bash
npm install          # cài jsdom + jszip cho test (chỉ dev)
npm test             # unit + integration test (GitHub API được giả lập)
npm run validate     # kiểm tra concepts.json ↔ concepts/
npm run serve        # chạy thử tại http://localhost:8080
```

## 9. Nâng cấp tùy chọn: đăng nhập GitHub OAuth

Nếu sau này muốn nhiều người quản trị đăng nhập bằng tài khoản GitHub (không phải dán token), thêm một serverless function nhỏ (Cloudflare Workers / Vercel, miễn phí) làm "OAuth broker":

1. Tạo **GitHub OAuth App** (callback về worker).
2. Worker đổi `code` → access token của người dùng, kiểm tra người dùng có quyền push vào repo, rồi trả token (hoặc giữ phiên qua cookie) cho frontend.
3. Frontend giữ nguyên: `github.js` chỉ cần token hợp lệ.

Client secret nằm trong biến môi trường của worker; repo vẫn không chứa secret.

## 10. Tiêu chí nghiệm thu đã đáp ứng

- Website quản lý qua HTTPS trên GitHub Pages; khách hàng xem không cần đăng nhập.
- Upload HTML hoặc ZIP; file lưu nguyên vẹn vào `concepts/<slug>/`; URL công khai thật, có nút Copy/Open.
- Chỉ báo thành công sau khi deploy được xác nhận (`data/build.json` trùng commit); deploy lỗi/timeout được báo rõ.
- Replace Version giữ nguyên link; Edit Details; Archive; Delete có xác nhận; khôi phục bằng Git.
- Thao tác ghi yêu cầu token có quyền push; không có secret trong frontend/repo; ZIP được kiểm tra an toàn; preview sandbox.
