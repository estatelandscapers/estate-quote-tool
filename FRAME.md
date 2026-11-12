# App frame (v43)

How the tool is laid out and what sits around the tabs. None of this changes what a tab does.

- **Dock** (`shell()` in `public/admin/app.js`): the tabs run down the left. Pricing, Recipes,
  Vendors and Editor sit under **Setup** (`SETUP_TABS`). On a phone the dock becomes a bottom
  bar (`MOBILE_TABS`) with **More** opening every section.
- **Top bar**: page title, search box, and the account menu (appearance, lead notifications,
  sign out).
- **Search** (`osSearch()` in `public/admin/os.js`, `GET /api/search`): leads, quotes, projects,
  purchase orders, inventory and costs for everyone; pricing and vendors for the admin.
  Read-only. Opens with the search box, Ctrl K / Cmd K, or `/`.
- **Welcome** (`osWelcome()`): after sign-in and on the first open each Sydney day. Six counts,
  each read from the same endpoint as the list it opens. Opens the tool by itself after 7 s
  (`OSWEL_MS`); tap a card to go to that list, tap elsewhere to skip.
- **Windows**: the lead and the figure lists open as centred pop-outs (`.drawer`), full screen
  on a phone.
- **Colour**: every tint is a token (`--ok-soft`, `--warn-soft`, `--bad-soft`, `--info-soft`,
  `--vio-soft`, with `-line` and `-ink` partners) defined for Light, Dark and AMOLED at the end
  of `styles.css`. Use a token, never a pale hex, so nothing glows in the dark themes.
- **Marketing refresh** (`POST /api/marketing/refresh`): pulls Meta now. Google cannot be
  pulled; its Ads script sends figures on its own schedule.
