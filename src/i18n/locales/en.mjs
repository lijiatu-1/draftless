// 英文：默认的语言，也是别的语言缺了哪句时的退路。别的语言照着这一份的结构写，名字和参数一一对上。
// {名字} 是参数；{ one, other } 是按 count 分单复数（Intl.PluralRules 的分法）。
// 给人看的一句话句尾不带标点（它常要接在别的话后面），整句的说明才带。

export default {
  common: {
    sentence: "{text}.",
    unknownReason: "unknown reason",
    close: "Close",
  },

  units: {
    seconds: "{value}s",
    minutesSeconds: "{minutes}m {seconds}s",
    minutes: "{minutes} min",
    hoursMinutes: "{hours} hr {minutes} min",
    min: "min",
    hr: "hr",
    words: { one: "word", other: "words" },
    wpm: "WPM",
    days: { one: "day", other: "days" },
  },

  periods: {
    today: "Today",
    month: "This month",
    total: "All time",
  },

  months: {
    jan: "Jan",
    feb: "Feb",
    mar: "Mar",
    apr: "Apr",
    may: "May",
    jun: "Jun",
    jul: "Jul",
    aug: "Aug",
    sep: "Sep",
    oct: "Oct",
    nov: "Nov",
    dec: "Dec",
  },

  permissions: {
    microphone: "Microphone",
    // Windows 上这两项不是"授权"，是小帮手把钩子装上没有：装上就有，装不上多半是安全软件拦了。
    // 名字也就照钩子说，状态用 installed / notInstalled
    listen: "Keyboard hook",
    trusted: "Click interception",
    granted: "Granted",
    denied: "Not granted",
    installed: "Installed",
    notInstalled: "Not installed",
    checking: "Checking…",
    openSettings: "Windows Settings",
    request: "Allow",
  },

  hotkeys: {
    right_alt: { name: "Right Alt", keycap: "Right Alt" },
    right_ctrl: { name: "Right Ctrl", keycap: "Right Ctrl" },
    right_shift: { name: "Right Shift", keycap: "Right Shift" },
    right_win: { name: "Right Win", keycap: "Right Win" },
  },

  themes: {
    ink: { name: "Ink", describe: "Black and white. Shape and motion show the state; color only for errors" },
    cinnabar: { name: "Cinnabar", describe: "A warm red on the wave and the main buttons" },
    indigo: { name: "Indigo", describe: "Color shows the stage: green listening, indigo refining, amber trouble" },
  },

  providers: {
    gemini: { getKey: "Get one at Google AI Studio" },
    openai: { getKey: "Get one at OpenAI Platform" },
    deepseek: { getKey: "Get one at DeepSeek Platform" },
    qwen: { getKey: "Get one at Alibaba Cloud Model Studio" },
  },

  language: {
    system: "System",
  },

  settings: {
    describe: {
      hotkey: "Which key starts and stops dictation",
      mode: "Which way to recognize speech: native sends the recording to a model that takes audio; local transcribes on this PC first, then has any LLM polish the text",
      model:
        "Which provider and model refines your words, as provider/model; a provider alone uses its default. Switch with draftless model",
      thinking: "Gemini's thinking level; higher is slower. Other providers don't use it",
      transcriber:
        "On the local path, which on-device model transcribes; download it first (draftless transcriber download)",
      polish:
        "On the local path, which provider and model polishes the text, as provider/model; for a custom service write custom/<model>",
      customUrl: "Address of your custom polishing service (OpenAI-compatible), e.g. https://api.example.com/v1",
      modelSource:
        "Where on-device models download from: cn is draftless's mirror in China, original is Hugging Face. If the chosen one stalls, the other is tried",
      theme: "Which theme the windows use",
      language: "Interface language; system follows Windows",
    },
    unknown: "There's no setting called {name}. You can change: {names}",
    notText: "must be text",
    oneOf: "must be one of {choices}",
    invalid: "{where} is {value}: {reason}",
    whereEnv: "The {variable} env var",
    whereFile: "{name} in the settings file {file}",
    unreadable: "Can't read the settings file {file} ({reason}). Fix it, or delete it and set things again.",
    notObject:
      'The settings file {file} isn\'t a set of "name": value pairs. Fix it, or delete it and set things again.',
  },

  models: {
    empty: "is empty",
    unknownProvider: "unknown provider {name}; available: {providers}",
    badName: "model name {model} is invalid: only letters, digits, and . _ : - are allowed",
  },
  modes: {
    native: "Native: the recording goes straight to the model",
    local: "Local: transcribed on this PC, then polished by a model",
    notIn: "You're in {current} mode; {what} can only be changed in {mode} mode",
    notOfMode: "{name} isn't a {mode} setting; switching to {mode} can also set {names}",
    notDownloaded: "{model} isn't downloaded yet ({size}): download it first",
    what: {
      model: "the audio model",
      transcriber: "the on-device transcription model (step 1)",
      polish: "the polishing model (step 2)",
    },
  },
  local: {
    modelDownloading: "The local model is still downloading ({percent}%); it'll work once it's done",
    modelLoading: "The local model is loading; give it a few seconds",
    modelFailed: "The local model couldn't be set up: {reason}",
    modelMissing:
      "The local model {model} isn't downloaded: download it on the Models page in Settings, or run draftless transcriber download {id}",
    undecodable: "Couldn't read the recording: {reason}",
    transcribeFailed: "Local transcription failed: {reason}",
  },
  modelSources: {
    cn: "China mirror (draftless CDN)",
    original: "Original (Hugging Face)",
  },
  localModels: {
    tags: {
      "apple-silicon": "suits Apple silicon",
      metal: "Metal-accelerated",
      cpu: "runs on CPU alone",
      "zh-en": "strong on mixed Chinese–English",
      fast: "fast",
      small: "small",
    },
    chips: {
      "apple-silicon": "Apple silicon",
      "intel-mac": "Intel Macs",
      "windows-x64": "Windows (x64)",
      "windows-arm64": "Windows (ARM)",
    },
    backends: { metal: "Metal", cpu: "CPU" },
    measured: "Measured on {chip} ({backend}): {score}/5 · {realtime}× real time · {memory} memory",
    notMeasured: "Not yet measured on {chip}",
    unknownChip: "Not yet measured on this kind of machine",
    unknown: "There's no model called {id}",
    noSpace: "Not enough disk space: {model} needs {need} more, and only {free} is free",
    downloadFailed: "{model} didn't download: {reason}",
    inUse: "{model} is in use and can't be deleted: switch to another model or back to native first",
    checkNoSpeech: "Couldn't speak the test sentence (uses the system voice): {reason}",
    checkFailed: "{model} failed to transcribe: {reason}",
    checkEmpty: "{model} didn't transcribe a single word",
  },
  chat: {
    modelRequired: "{vendor} has no default model; write it as {vendor}/<model name>",
    badModelName: "model name {model} is invalid: only letters, digits, and . _ : / @ + - are allowed",
    urlEmpty: "the address is empty",
    urlNotHttp: "{url} isn't a web address; it should start with https:// or http://",
    urlCredentials: "don't put a username or password in the address; the key goes in separately",
    urlQuery: "the address can't contain ? or #",
    urlMissing: "no address set for the custom service (customUrl)",
    endpointNotFound:
      "{provider} has no chat API at this address (HTTP 404). Check the address is complete; most end in /v1",
  },

  setup: {
    openSettings: "tray icon › Settings",
    missing: {
      key: "{provider} API key",
      check: "{provider} check",
      microphone: "microphone access",
      listen: "keyboard hook",
      helper: "key listener",
      localModel: "local model",
    },
    blocker: {
      noKey: "No {provider} API key: {where}",
      checkFailed: "{provider} check failed: {problem}",
      keyRejected: "API key not working: {problem}",
      checking: "Checking the API key, one moment",
      noMicrophone: "No microphone access: {where}",
    },
    degraded:
      "The click-interception hook isn't installed, so Esc and the floating bar's buttons won't work. Security software may be blocking it",
  },

  key: {
    empty: "No key entered",
    tooLong: "This key is too long ({length} characters). Looks like a copy mistake",
    whitespace: "This key has spaces or line breaks. Looks like extra text got copied",
    badCharacters: "This key has characters that don't belong. Looks like a copy mistake",
    unreadable: "The saved key can't be read anymore. Enter it again",
    unreadableFor: "The saved {provider} key can't be read anymore. Enter it again",
    notSaved: "The key works but wasn't saved ({reason}). You'll need to enter it again after quitting",
    keychainUnavailable: "Windows couldn't encrypt the key safely, so it isn't stored",
    external: "Connected to a separately started server (DRAFTLESS_SERVER_URL); set the key there",
    externalModel: "Connected to a separately started server (DRAFTLESS_SERVER_URL); the model is chosen there",
    noKeyFor: "No {provider} key yet. Add one first",
    noKeyForCli: "No {provider} key yet: run draftless key {id}",
    unknownProvider: "Unknown model provider: {id}",
    noKeyService:
      "No {provider} API key yet: run draftless key in a terminal, or open Settings from the draftless tray icon",
  },

  model: {
    timeout: "{provider} took too long to reply. Try again later",
    unreachable: "Can't reach {provider}. Check your network",
    keyInvalid: "This key is invalid. Check it was copied in full",
    unavailable: "{provider} is unavailable right now ({said}). Try again later",
    rejected: "{provider} rejected the request: {said}",
    regionBlocked:
      "{provider} isn't available in your network's region ({said}). Check your proxy or switch networks; the key is fine",
    noQuota: "This key's account is out of credit. Top up or use another key",
    forbidden: "This key lacks permission: {said}",
    notFound: "{provider} doesn't have this model, or this key can't use it: {said}",
    blocked: "{provider} didn't process this recording: {reason}",
    unfinished: "{provider} didn't finish normally: {reason}",
  },

  audio: {
    undecodable: "Couldn't decode the recording ({type}): {reason}",
    empty: "Couldn't decode the recording ({type}): it has no audio",
  },

  voice: {
    noAudio: "No audio received",
    connectTimeout: "Timed out connecting to the server",
    unreachable: "Can't reach the server at {url}",
    disconnected: "Lost the connection to the server",
    timeout: "No result after {seconds} seconds",
    serverError: "Server error {code}: {detail}",
  },

  delivery: {
    silent: "Didn't hear anything, or the sentence was only filler",
    // UIPI：管理员权限的窗口收不到模拟按键，这时文字留在剪贴板里，让人自己按 Ctrl+V
    noAccessibility: "Can't paste into administrator windows: text copied, press Ctrl+V to paste",
    pasteFailed: "Couldn't paste: text copied, press Ctrl+V to paste",
    pasteFailedNoClipboard: "Couldn't paste, and the clipboard is busy too: the text is in History, copy it from there",
    notEditable: "The caret isn't in something editable: text copied, press Ctrl+V to paste",
  },

  bar: {
    opening: "Opening microphone…",
    recording: "Press {key} to finish · {esc} to cancel",
    recordingNoEsc: "Press {key} to finish",
    finishing: "Refining",
    noHold: "No need to hold: press once to start, again to finish",
    countdown: "Auto-stops in {seconds} s",
    noMicPermission: "No microphone access: Settings › Privacy & security › Microphone",
    noMicrophone: "No microphone found",
    noSignal: "The microphone isn't picking anything up: check the input device and mute",
    recordError: "Recording error: {reason}",
    helperStopped:
      "The keyboard hook stopped, so {hotkey} won't work. Try restarting draftless; security software may be blocking it",
  },

  tray: {
    ready: "Ready · press {keycap} to talk",
    missing: "Missing: {items}",
    preparing: "Getting ready…",
    open: "Open Draftless",
    history: "History",
    settings: "Settings…",
    version: "Version {version}",
    quit: "Quit Draftless",
    // 提示里第一行是名字，第二行是状态：任务栏上悬停一眼就能认出是哪个程序
    tooltip: "Draftless",
  },

  notes: {
    settingNotSaved: "Switched, but couldn't save {name} to settings ({reason}) · next launch goes back",
    envNextLaunch: "The {variable} env var takes priority · next launch still uses it",
    envRemove: "The {variable} env var takes priority · remove it to apply",
  },

  hub: {
    pages: "Pages",
    home: "Home",
    history: "History",
    settings: "Settings",
    about: "About",
    missing: "Missing: {items}",
    fix: "Settings",
  },

  home: {
    title: "Speak, don't type",
    words: "Words",
    saved: "Time saved",
    speed: "Speed",
    time: "Dictation time",
    active: "Active",
    streak: "Streak",
    longest: "Longest",
    activity: "Dictations per day",
    earlier: "Earlier",
    later: "Later",
    less: "Less",
    more: "More",
    notStarted: "{day} · not started yet",
    dayCount: { one: "{day} · {count} dictation · {level}", other: "{day} · {count} dictations · {level}" },
    dayLevel: "{day} · {level}",
    levels: {
      none: "No activity",
      light: "Light usage",
      moderate: "Moderate usage",
      high: "High usage",
      power: "Power usage",
    },
    spend: { today: "Spent today", month: "Spent this month", total: "Spent in all" },
    spendPeriods: "Period",
    model: "Model",
    cost: "Cost",
    tokens: "Tokens",
    count: "Count",
    latency: "Latency",
    local: "On-device",
    free: "Free",
    sum: "Total",
    emptyPeriod: "Nothing used in this period",
    checks: { one: "Includes {count} check", other: "Includes {count} checks" },
    cache: "Prompt cache {cost}",
    estimate: "Estimated at list prices",
    unpriced: "{models} unpriced; {count} not counted",
    dictate: "Press to talk",
  },

  history: {
    title: "History",
    empty: "Nothing yet · press {keycap} to say something",
    loadError: "Couldn't read history: {reason}",
    today: "Today",
    yesterday: "Yesterday",
    silent: "Audio is silent",
    failed: "Failed · ",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    recording: "Recording {duration}",
    model: "Model {latency} · {cost}",
    tokens: "In {input} · out {output} tokens",
    tokensCalls: "In {input} · out {output} tokens · {calls} calls",
    unpriced: "price unknown",
  },

  preferences: {
    title: "Settings",
    sections: "Settings sections",
    general: "General",
    model: "Model",
    permissions: "Permissions",
    about: "About",
    hotkey: "Shortcut",
    theme: "Theme",
    language: "Language",
    openAtLogin: "Launch at login",
    hotkeyFailed: "Not changed: {reason}",
    themeFailed: "Theme not changed: {reason}",
    languageFailed: "Language not changed: {reason}",
    loginFailed: "Couldn't set launch at login: {reason}",
    recheck: "Check again",
    version: "Version",
    dataFolder: "Data folder",
    source: "Source code",
    modes: {
      label: "Recognition mode",
      native: "Native",
      local: "Local",
      nativeHint: "Your recording goes straight to a model that takes audio, finished in one step.",
      localHint: "This PC transcribes first, then an LLM polishes the text. Audio stays on your PC.",
      inUse: "In use",
      use: "Use {mode}",
    },
    local: {
      step1: "Step 1 · On-device transcription",
      step2: "Step 2 · Polishing",
      source: "Download from",
      downloaded: "Downloaded",
      downloading: "Downloading {percent}% ({size})",
      notDownloaded: "Not downloaded · {size}",
      partial: "{percent}% downloaded",
      downloadFailed: "Download failed",
      download: "Download · {size}",
      resume: "Resume · {size} left",
      cancel: "Cancel",
      delete: "Delete",
      confirmDelete: "Confirm delete",
      check: "Check",
      checking: "Checking: reading it a sentence…",
      checkOk: "Works",
      downloadFirst: "Download it first to choose it",
      summary: "{count} of {all} downloaded on this PC, {size} in total",
      freeSpace: "{size} free on disk",
      loading: "Loading",
      ready: "Ready · {backend}",
      failed: "Not set up",
      retry: "Retry",
      polishModel: "Model",
      customModel: "Model name",
      customModelPlaceholder: "e.g. qwen3:8b",
      customUrl: "Address",
      customUrlPlaceholder: "https://api.example.com/v1",
      apply: "Apply",
    },
  },

  keyPanel: {
    models: "Model",
    inUse: "In use",
    use: "Use {provider}",
    placeholder: "Paste key",
    paste: "Paste",
    customName: "Custom service",
    save: "Save & verify",
    saveAndUse: "Save & use {provider}",
    forget: "Delete key",
    replace: "Replace key",
    keepKey: "Keep this key",
    verifying: "Verifying…",
    failed: "Didn't work: {reason}",
    clipboardEmpty: "Clipboard is empty",
    confirmForget: "Delete the {provider} key?",
    confirmForgetInUse: "Delete the {provider} key? You'll need to add it again to dictate",
    other: {
      env: "Using the {variable} env var",
      stored: "Saved",
      none: "Not set · add a key to switch to {provider}",
    },
    check: {
      button: "Check",
      running: "Checking…",
      ok: "Works",
      failed: "Doesn't work: {problem}",
    },
    state: {
      env: "Using the {variable} env var · not saved",
      envUnverified: "Using the {variable} env var · not saved · not verified (couldn't reach {provider} at launch)",
      external: "Set by the separately started server",
      saved: "Saved · verified",
      savedUnverified: "Saved · not verified (couldn't reach {provider} at launch)",
      checking: "Verifying…",
      checkFailed: "Check failed: {problem} · the key may be fine; see draftless model",
      envRejected: "The key in the {variable} env var doesn't work: {problem} · fix or remove it, then restart",
      rejected: "The key doesn't work: {problem}",
      missing: "Not set",
    },
  },

  onboarding: {
    groups: { key: "Model", setup: "Set up", try: "Try it" },
    key: {
      soft: "Connect a ",
      title: "model",
      spoken: "“Um, let's meet at nine tomorrow, no wait, nine thirty…”",
      result: "Let's meet at 9:30 tomorrow.",
    },
    permissions: {
      soft: "Turn on ",
      title: "microphone access",
      allow: "Allow",
      on: "✓ On",
      history: "History stays on this PC",
      audio: "Audio goes only to your model",
      key: "Key encrypted by Windows, kept on this PC",
    },
    microphone: {
      soft: "Speak to ",
      title: "test the mic",
      question: "Are the bars moving?",
      yes: "Yes, continue",
      no: "No",
      help: "Check the input device and volume in Settings › System › Sound, or turn on",
      settings: "Microphone access",
      error: "Can't open the microphone: {reason}",
    },
    hotkey: {
      soft: "Press it to ",
      title: "test the shortcut",
      question: "Did the key light up?",
      yes: "Yes, continue",
      no: "No, pick another key",
      switchTo: "Switch to",
      switched: "Switched. Press it to try",
      failed: "Not switched: {reason}",
    },
    try: {
      soft: "Now, ",
      title: "say something",
      sample: "Um, let's meet tomorrow at nine, no wait, nine thirty, and bring last week's numbers.",
      notes: "Notes",
      placeholder: "Click here, press {keycap}, read the line on the left, then press it again",
    },
    done: { soft: "Speak, ", title: "don't type", start: "Get started" },
    back: "Back",
    next: "Continue",
    skip: "Skip",
  },

  paths: {
    homeNotAbsolute: "The DRAFTLESS_HOME env var must be an absolute path; it's {home}",
    homeTooLong:
      "The draftless folder path is too long for the control socket: {home}\nUse the DRAFTLESS_HOME env var to pick a shorter one.",
  },

  control: {
    notRunning: "draftless isn't running",
    timeout: "draftless didn't reply within {seconds} seconds (command {command})",
    unreadable: "Couldn't understand draftless's reply (command {command})",
  },

  storage: {
    historyTooNew:
      "The history database is version {found}, newer than this program knows ({known}), so it won't touch it",
    historyTooOld:
      "The history database is version {found}, but this program expects {known}: start draftless once, or update to the latest version",
    legacyRunning:
      "An old version of draftless is still running, so its data can't be moved. Quit it first (tray → Quit), then run this again.",
  },

  cli: {
    help: `draftless: press a hotkey, speak, and polished text is pasted into the current text box.

  draftless                     Start (just shows status if already running). First run asks for an API key (Gemini by default)
  draftless start               Same as above
  draftless stop                Stop
  draftless restart             Restart
  draftless status [--json]     Status: running or not, key, the microphone and the two hooks, how much you said today and in total
  draftless update              Look for a newer version and say how to install it. Settings, keys, history, and recordings are kept

  draftless history [-n count] [--json]
                                What you said, grouped by day, newest first (latest {limit} by default)
  draftless usage [--json]      What it cost: spend and tokens today, this month, and in total, model reply times, per model
  draftless mode                The two recognition modes and what each uses: native sends the recording to the model; local transcribes on this PC, then a model polishes it
  draftless mode <native|local> [--model …] [--transcriber …] [--polish … --url …]
                                Switch mode, live. Can bring that mode's own settings, e.g. a custom service on first entering local
  draftless model               Native mode: available providers ({providers}), whether each has a key, which one is in use
  draftless model <provider>[/<model>]
                                Switch provider or model in native mode, e.g. draftless model openai. Asks for its key if missing
  draftless transcriber [<model>]
                                Local mode, step 1: list or switch the on-device transcription model. Asks before downloading one you don't have
  draftless transcriber download|cancel|delete <model> [--yes]
                                Download, stop downloading, or delete an on-device model (in any mode; the one in use can't be deleted)
  draftless transcriber check [<model>]
                                Check an on-device model: the system voice reads a sentence and the model transcribes it. Defaults to the selected one
  draftless polish [<provider>[/<model>] [--url <url>]]
                                Local mode, step 2: list or switch the polishing model ({polishers}). custom is any OpenAI-compatible service
  draftless polish check [<provider>[/<model>]]
                                Check step 2 works
  draftless model check [<provider>[/<model>]]
                                Check it works: sends that provider a minimal request with its key. Defaults to the current one
  draftless key [<provider>]    Replace a key; defaults to the current provider (input is hidden; can also be piped in)
  draftless key --forget [<provider>]
                                Delete the saved key
  draftless config              Settings: hotkey, model, thinking level, theme, language, and where data and logs live
  draftless config set <name> <value>
                                Change one directly, with no checks (the mode and model commands above check first)
  draftless config unset <name> Reset to the default
  draftless theme               List themes and the one in use
  draftless theme <name>        Switch theme ({themes}); applies right away, no restart
  draftless settings            Open Settings (to allow the microphone or retry the two hooks)
  draftless logs [-n lines] [-f]
                                Show logs; -f keeps following
  draftless uninstall [--keep-data] [--yes]
                                Uninstall: stop it and delete the whole draftless folder. --keep-data keeps settings, keys, history, and recordings

  draftless help                This help
  draftless --version           Version
`,
    winOnly:
      "draftless runs on Windows only: the hotkey hook, pasting, and key encryption all use Windows system APIs.",
    nodeVersion: "draftless needs Node 22.13 or newer (23.4 or newer on the 23 line); this is {version}.",
    unknownCommand: "There's no command called {name}.",
    seeHelp: "Run draftless help to see all commands.",
    stuck: "It may be stuck. Run draftless stop to force it to stop, then run draftless to start it again.",
    migrated: "Moved the old version's data to {home} ({items}).",
    badArgs: "Invalid arguments: {reason}",
    extraArgs: "Unexpected argument {args}. Usage: {usage}",
    positiveInteger: "{flag} needs a positive integer",
    starting: "Starting draftless…",
    runRestart: "run draftless restart",
    packagedRelaunch: "right-click the Draftless tray icon → Quit Draftless, then start draftless again",
    syntax: {
      start: "draftless start",
      stop: "draftless stop",
      restart: "draftless restart",
      status: "draftless status [--json]",
      history: "draftless history [-n count] [--json]",
      usage: "draftless usage [--json]",
      logs: "draftless logs [-n lines] [-f]",
      settings: "draftless settings",
      uninstall: "draftless uninstall [--keep-data] [--yes]",
      config: "Usage: draftless config | draftless config set <name> <value> | draftless config unset <name>",
      theme: "Usage: draftless theme | draftless theme <name>",
      model:
        "Usage: draftless model | draftless model <provider>[/<model>] | draftless model check [<provider>[/<model>]]",
      mode: "Usage: draftless mode | draftless mode <native|local> [--model …] [--transcriber …] [--polish … --url …]",
      transcriber:
        "Usage: draftless transcriber | draftless transcriber <model> | draftless transcriber download|cancel|delete <model> [--yes] | draftless transcriber check [<model>]",
      polish:
        "Usage: draftless polish | draftless polish <provider>[/<model>] [--url <url>] | draftless polish check [<provider>[/<model>]]",
    },
    update: {
      fromSource: "This copy runs from source ({dir}): update it with git pull.",
      unreachable: "Couldn't reach {url}: {reason}",
      badVersion: "The download server returned a bad version number: {value}",
      upToDate: "Already up to date ({version}).",
      updating: "Updating draftless {current} → {latest}",
      updatingApp: "Updating Draftless.exe {current} → {latest}",
      appDone: "Draftless.exe is now {version}.",
      reopened: "Started Draftless again.",
      // 这一版不自己装：说清楚人要做什么
      notConfigured:
        "This build has no update source configured, so there's nothing to check against. Install a newer release by hand.",
      manual:
        "This build can't install an update by itself: download the release and unpack it in the same place, or run the install script again.",
      howto:
        "To update: download the new release from {base} and unpack it over the old copy, or run the install script again.",
      quitFirst: "Quit the running Draftless first: it has the old program's files open.",
      appChecksum:
        "The downloaded {file} doesn't match the release; it was probably damaged on the way. Run draftless update again.",
      appMount: "Couldn't unpack the downloaded {file}: {reason}",
      appWrongPackage: "The downloaded {file} doesn't contain Draftless {version}, so nothing was installed.",
      appUnsigned: "The downloaded Draftless isn't properly signed, so it wasn't installed: {reason}",
      appOtherDeveloper:
        "The downloaded Draftless is signed by a different developer ({found}; the installed one is {installed}), so it wasn't installed.",
      appReplace: "Couldn't replace {path}: {reason}. You can download {url} and unpack it over the old copy yourself.",
      available: "draftless {latest} is out (you have {current}): run draftless update.",
    },

    lifecycle: {
      openedOnboarding:
        "Opened the setup guide. Allow the microphone there, let it retry the two hooks, then run draftless status to check.",
      openedSettings:
        "Opened Settings. Allow the microphone there or retry the two hooks, then run draftless status to check.",
      notRunning: "draftless wasn't running.",
      stopped: "draftless stopped.",
      killed: "draftless was stuck and has been force-quit.",
      packagedRestart:
        "The running Draftless is the installed copy, started from the Start menu or a shortcut. Restarting it from the command line would replace it with a copy started from that terminal.",
      howToRestart: "To restart it: {relaunch}.",
    },
    key: {
      prompt: "Paste the key and press Enter (input is hidden): ",
      need: "draftless needs a {provider} API key: recordings are sent to {provider} to become text.",
      getOne: "Don't have one? Get one here: {url}",
      storage: "It's encrypted by Windows for your user account and stays on this PC.",
      skip: "Press Enter to skip for now.",
      legacyDaemon:
        "The running draftless is an old version that doesn't know {provider} keys yet: {restart} first, then try again.",
      verifying: "Verifying…",
      saved: "Key saved and verified.",
      rejected: "This key didn't pass: {problem}",
      notInline:
        "Don't put the key after the command: it would stay in your shell history. Run draftless key and paste it, or pipe it in: Get-Clipboard | draftless key. To set one for a specific provider, add its name: {providers}",
      forgotten: "Deleted the saved {provider} key.",
      cancelled: "Cancelled; the key is unchanged.",
      nothingRead: "No key read; the old one is unchanged.",
      badShapeUnchanged: "{problem}. The old one is unchanged.",
      switchHint: "To use it: {command}",
      needText:
        "You need a {provider} API key: recordings are transcribed on this PC, and only the text goes to {provider} for polishing.",
      customWithModel:
        "A custom service's key goes in together with its model and address: draftless polish custom/<model> --url <url> (not in local mode yet: draftless mode local --polish custom/<model> --url <url>)",
    },
    config: {
      nextLaunch: "Takes effect next launch.",
      packaged: "The running Draftless is the installed copy. To apply the new settings: {relaunch}.",
      restarting: "Restarting draftless to apply…",
      restartedBroken: "Restarted, but it can't be used now: {problem}",
      undo: "To undo this change: {undo}",
      restartedKeyBad:
        "Restarted, but the {provider} key doesn't work: {problem}. Run draftless key {id} to replace it",
      restartedNoKey: "Restarted, but there's no {provider} key yet, so it can't be used: run draftless key {id}",
      restartedStarting: "Restarted, but not ready yet: run draftless status to check.",
      restartedUnverified:
        "Restarted, but couldn't reach {provider}, so the new settings aren't verified yet: run draftless status in a bit.",
      applied: "Applied.",
      oldDaemonLive: "The running draftless is an old version and won't switch on the fly: run draftless restart.",
      appliedLive: "Applied, no restart needed.",
      themeOverridden:
        "The running draftless still uses {theme}: {variable} is set where it was started, and it overrides the settings file.",
      languageOverridden:
        "The running draftless still uses {language}: {variable} is set where it was started, and it overrides the settings file.",
      modelSourceOverridden:
        "The running draftless still uses {source}: {variable} is set where it was started, and it overrides the settings file.",
      envWarning: "Note: the {variable} env var is set and overrides this value.",
      changed: "{name} set to {value}.",
      modeCommand:
        "This is usually changed with {command}, which checks it works first and leaves it alone if not. config set skips the checks and writes it straight in.",
      otherMode: "You're in {current} mode now; this takes effect when you switch to {mode} mode.",
      unset: "{name} reset to the default, {value}.",
      themeChanged: "Theme set to {theme}.",
      notRunning: "draftless isn't running. Run draftless to start it first.",
      settingsOpened: "Settings opened.",
      title: "Settings",
      choices: "{describe}. Options: {choices}",
      hintSet: "Change one: draftless config set hotkey right_win",
      hintUnset: "Reset one: draftless config unset hotkey",
      hintKey: "Replace the key: draftless key",
      hintTheme: "Switch theme: draftless theme",
      folder: "Folder",
      settingsFile: "Settings file",
      log: "Log",
      oneFolder: "The program, settings, keys, history, and recordings all live in this one folder.",
      uninstallHint: "Done with it? draftless uninstall stops it and deletes the whole folder.",
    },
    source: {
      default: "default",
      file: "from the settings file",
      env: "from the {variable} env var this run",
    },
    themeTitle: "{name} ({id})",
    themes: {
      title: "Themes",
      current: "Using {theme} · {source}",
      switch: "Switch: draftless theme {id} (applies right away, no restart)",
    },
    modes: {
      title: "Recognition modes",
      notIn: "You're in {current} mode; {what} can only be changed in {mode} mode: run draftless mode {mode} first",
      notSwitched: "Not switched: {problem}",
      applied: "Switched, no restart needed.",
      downloading:
        "The local model is downloading in the background ({percent}%); it'll work once it's done. Progress: draftless status",
      loading: "The local model is loading; a few seconds.",
      switch: "Switch: draftless mode {mode} (takes effect right away)",
      nativeModels: "Change the model in native: draftless model",
      localHops:
        "The two steps of local: draftless transcriber (step 1, on-device) · draftless polish (step 2, polishing)",
      withSettings:
        "Use a custom service on first entering local: draftless mode local --polish custom/<model> --url <url>",
      flagsFor: "{flag} isn't a {mode} setting; switching to {mode} can bring {flags}",
      already: "Already in {mode} mode: {route}.",
      switched: "Switched to {mode} mode: {route}.",
      localRoute: "{transcriber} → {polish}",
    },
    local: {
      notInLocal: "You're in {current} mode, so these aren't in use: switch first (draftless mode local)",
      transcribersTitle: "On-device transcription models (local mode, step 1)",
      installed: "downloaded",
      notInstalled: "not downloaded",
      downloading: "downloading {percent}%",
      partial: "{percent}% downloaded",
      downloadFailed: "download failed",
      summary: "{count} of {all} downloaded on this PC, {size} in total",
      freeSpace: "{size} free on disk",
      transcriberCurrent: "In use: {model}",
      transcriberSwitch: "Switch: draftless transcriber {id}",
      transcriberManage: "Download: draftless transcriber download {id} · stop: cancel · remove: delete · check: check",
      downloadStart: "Downloading {model} ({size}, from {source})…",
      downloadBackground:
        "draftless is downloading it in the background: Ctrl-C only stops watching; to stop the download, run draftless transcriber cancel {id}",
      downloadProgress: "Downloading {percent}% ({received} / {total})",
      downloadDone: "{model} is downloaded.",
      downloadAlready: "{model} is already downloaded.",
      downloadStopped:
        "The {model} download stopped (cancelled elsewhere). Finished files are kept; a half-done file starts over next time.",
      downloadInterrupted:
        "draftless quit during the download. Finished files are kept; run draftless transcriber download {id} to continue.",
      nothingToCancel: "{model} isn't downloading.",
      cancelled: "Stopped downloading {model}. Finished files are kept; a half-done file starts over next time.",
      notOnDisk: "{model} isn't downloaded, so there's nothing to delete.",
      deleteConfirm: "Delete {model} ({size})? You'll need to download it again to use it. Type y to confirm: ",
      deleteNeedsConfirm:
        "Deleting needs confirmation: run it in a terminal, or add --yes (draftless transcriber delete {id} --yes)",
      deleteAborted: "Nothing deleted.",
      deleted: "Deleted {model}, freeing {size}.",
      oldDaemonDelete:
        "The running draftless is an old version that can't tell which model is in use, so nothing was deleted: run draftless restart, then try again.",
      checking: "Checking {model}: reading it a sentence…",
      checkOk: "{model} works. Read “{said}”, got “{text}”, transcribed in {seconds}.",
      checkLoaded: "It wasn't in use: loading it took {seconds}, and it's unloaded again.",
      oldDaemonCheck:
        "The running draftless is an old version that can't check on-device models: run draftless restart, then check again.",
      notDownloadedAsk: "{model} isn't downloaded yet ({size}, from {source}). Download it now? Type y to download: ",
      notDownloadedHint: "{model} isn't downloaded yet: run draftless transcriber download {id} first",
      notDownloadedLater:
        "Nothing downloaded or switched. To download it later, run draftless transcriber download {id}",
      transcriberSwitched: "Step 1 is now {model}.",
      polishTitle: "Polishing models (local mode, step 2)",
      customName: "Custom service",
      customModel: "your own model and address",
      alsoModels: "also: {models}",
      polishCurrent: "In use: {model}",
      polishSwitch: "Switch: draftless polish deepseek/deepseek-v4-pro",
      polishCustom: "Custom service (OpenAI-compatible): draftless polish custom/<model> --url <url>",
      polishCheck: "Check it works: draftless polish check",
      polishSwitched: "Step 2 is now {model}.",
      urlNeeded: "A custom polishing service needs its address: --url <url> (OpenAI-compatible; most end in /v1)",
      sourceCurrent: "Downloads from: {source}",
      sourceSwitch: "Change: draftless config set modelSource {other} (falls back to the other if one stalls)",
    },
    choose: {
      question: "First, pick how recordings become text (change it later with draftless mode or draftless model):",
      native: "native mode: the recording goes straight to the model",
      local:
        "local mode: transcribed on this PC, only the text goes to a model for polishing (first use downloads a {size} local model)",
      custom:
        "  To use another service (OpenAI-compatible): after setup, run draftless mode local --polish custom/<model> --url <url>",
    },
    model: {
      textOnly:
        "{provider} only takes text; it's step 2 of local mode: draftless polish {id} (not in local mode yet? draftless mode local first)",
      notInNative: "You're in {current} mode, so these models aren't in use: switch back first (draftless mode native)",
      unknownProvider: "Unknown provider {name}; available: {providers}. To pick a model, write provider/model",
      invalid: "Model is {value}: {reason}",
      describe: "{provider} {model}",
      option: "default {model}",
      optionWithKey: "default {model}, key already set",
      choose: "First, pick whose model turns your recordings into text (change it later with draftless model):",
      choosePrompt: "Enter a number and press Enter (just Enter picks {fallback}): ",
      choosePromptAgain: "Enter a number and press Enter: ",
      choiceItem: "{number} ({name})",
      noSuchChoice: "There's no option {answer}; choose {choices}.",
      noKeyNonInteractive: "No {provider} key yet, so nothing changed: run draftless key {id} first, then switch.",
      notSwitched: "Not switched: no {provider} key yet.",
      switched: "Model switched to {model}.",
      checking: "Checking {model}…",
      oldDaemonCheck:
        "The running draftless is an old version and can't check: run draftless restart, then check again.",
      unusable: "Not usable: {problem}",
      usable: "Works: {model}, using {from}, round trip {seconds}s.",
      fromEnv: "the key in the {variable} env var",
      fromStored: "the saved key",
    },
    models: {
      title: "Models",
      default: "{model} (default)",
      keyStored: "key saved",
      keyEnv: "key from the {variable} env var",
      noKey: "no key yet",
      current: "Using {provider} {model} · {source}",
      switch: "Switch provider: draftless model {id} (asks for its key if missing)",
      pick: "Pick a model: draftless model {id}/{model}",
      check: "Check it works: draftless model check (no argument checks the current one)",
    },
    status: {
      notRunning: "not running",
      runToStart: "Run {command} to start it.",
      starting: "starting",
      running: "running",
      missingCount: { one: "running, {count} thing missing", other: "running, {count} things missing" },
      preparing: "running, getting ready",
      ready:
        "Ready: click into any text box, press {hotkey} to start talking, press it again to finish, and the text gets pasted in.",
      missing: "Missing: {items}.",
      key: "Key",
      permissions: "Permissions",
      hotkey: "Hotkey",
      model: "Model",
      theme: "Theme",
      language: "Language",
      today: "Today",
      total: "All time",
      modelExternal: "decided by the separately started server",
      mode: "Mode",
      localModel: "Local model",
      localReady: "ready · {backend}",
      localDownloading: "downloading {percent}% ({received} / {total} MB)",
      localLoading: "loading",
      localMissing: "not downloaded: draftless transcriber download {id}",
      modelInUse: "{provider} {model}",
      modelWithThinking: "{provider} {model} ({thinking})",
      keyEnv: "Using the one in the {variable} env var this run, not saved",
      keyEnvUnverified:
        "Using the one in the {variable} env var this run, not saved; couldn't reach {provider} at launch, so it isn't verified yet",
      keyExternal: "Connected to a separately started server; the key is set there",
      keySaved: "Saved and verified",
      keySavedUnverified: "Saved; couldn't reach {provider} at launch, so it isn't verified yet",
      keyChecking: "Verifying…",
      keyCheckFailed: "Check failed: {problem}. The key may be fine; check the {what} first: draftless config",
      modelAndLevel: "model and thinking level",
      modelOnly: "model",
      keyEnvRejected:
        "The key in the {variable} env var doesn't work: {problem}. Fix it or remove the variable, then restart",
      keyRejected: "Not working: {problem}. Run draftless key to replace it",
      keyUnreadable: "{problem}: run draftless key",
      keyMissing: "Not set: run draftless key",
      dictations: { one: "{count} dictation", other: "{count} dictations" },
      characters: { one: "{count} character", other: "{count} characters" },
      pace: "{count} characters/min",
      atLeast: "at least {cost}",
      costUnknown: "cost unknown",
      pending: "Changed in settings but not applied yet ({names}): {relaunch}.",
      helperStopped:
        "The keyboard-hook helper stopped, so the hotkey won't work: {relaunch}. If it keeps happening, see draftless logs.",
      openSettings:
        "Run {command} to open the permissions page in Settings: the microphone has a button to Windows Settings, and “Check again” reinstalls the two hooks.",
      ownerApp:
        "The microphone permission belongs to the app itself; look for “Draftless” in the Windows Settings list.",
      ownerTerminal:
        "Started from a terminal: the microphone permission belongs to whatever shows up in the Windows Settings list (Electron, when running from source).",
      footer: `draftless history  what you said     draftless config  view and change settings
draftless usage    what it cost      draftless stop    stop it
draftless help     all commands`,
    },
    history: {
      empty: "No dictations yet. Run {command} to start, then press the hotkey and say something.",
      today: "Today · {date}",
      yesterday: "Yesterday · {date}",
      failed: "✗ Failed: {reason}",
      recording: "Recording {seconds}s, kept at {path}",
      notSaved: "(not saved)",
      more: "Showing the latest {shown} of {total}. Run draftless history -n {total} to see all.",
    },
    usage: {
      empty: "No usage yet. Say something first: every model call's cost, tokens, and reply time get recorded.",
      title: "Usage",
      cost: "Cost",
      tokens: "Tokens",
      dictations: "Dictations",
      latency: "Model reply",
      waiting: "usually {median}, slow {slow}",
      usually: "usually {median}",
      unpriced: "price unknown",
      localModel: "{name} (on-device)",
      free: "free",
      times: { one: "{count} dictation", other: "{count} dictations" },
      byModel: "By model (all time)",
      tokensNote:
        "All-time tokens: input {input} (audio {audio}, cached {cached}), output {output} (thinking {thinking}).",
      checksNote: { one: "Includes {count} key check.", other: "Includes {count} key checks." },
      cacheNote: "{cost} of the cost is prompt caching (creating and keeping it).",
      unpricedNote: "{models} aren't in the price list; those {count} calls aren't counted.",
      estimateNote:
        "Costs are USD estimates at each provider's standard price; Gemini use within the free tier is actually free.",
    },
    logs: {
      none: "No logs yet: draftless writes them to {file} once it has started",
    },
    uninstall: {
      yours: "settings, keys, history, and recordings",
      needsConfirm: "Uninstalling needs confirmation. Add --yes when not running in a terminal.",
      planKeep: "About to uninstall draftless: delete the program and runtime in {home}, keeping your {yours}.",
      planAll:
        "About to uninstall draftless: delete all of {home}, including the program, runtime, and your {yours}. This can't be undone.",
      confirm: "Are you sure? Type y and press Enter: ",
      aborted: "Nothing changed.",
      removedKeep: "the program, runtime, logs, and cache in {home}",
      keychainItem: "the keys saved with Windows encryption",
      keychainFailed:
        "The keys saved with Windows encryption weren't deleted ({reason}): delete the key files in the draftless folder by hand",
      removedAll: "{home} (the program, runtime, and your {yours})",
      done: "draftless uninstalled.",
      removed: "Deleted: {item}",
      kept: "Kept: your {yours} in {home}. Reinstall to pick up where you left off; delete the folder if you don't need them",
      leftovers: "Still on your system:",
      permissions:
        "The microphone permission is untouched: it belongs to the app and can be turned off in Settings › Privacy & security › Microphone. The two hooks go away with the program",
      sharedPrefs:
        "{file} is untouched: a small file in %APPDATA% where the runtime remembers things like window sizes, shared by every app built on stock Electron",
      sourceDir: "Source folder is untouched: {dir}",
    },
    daemon: {
      noElectron: "Can't find Electron: dependencies aren't fully installed. Run npm install in {dir} and try again.",
      downloading: "First launch: downloading the Electron runtime (about 100 MB)…",
      downloadFailed: "Electron didn't download ({reason}). Check your network and run this again.",
      emptyLog: "(the log is empty)",
      micPrompt: "Windows is asking for microphone access: click “Yes” (the dialog shows the app's name).",
      verifying: "Verifying key…",
      building: "First launch: building the keyboard-hook helper…",
      signal: "ended by signal {signal}",
      exitCode: "exit code {code}",
      exitedEarly: "exited midway",
      failed: "draftless failed to start ({reason}). Last lines of the log {file}:\n{tail}",
      noAnswer: "draftless didn't respond within {seconds} seconds of starting. Check the log: {file}",
      stuckNoPid:
        "draftless is stuck and not answering, and its process can't be identified. Find the process named Electron or draftless in Task Manager and end it.",
      cantStop: "Can't stop draftless (PID {pid}). End it in Task Manager.",
      // Windows 自带 .NET Framework 的 csc.exe，编译不用另装东西：缺了多半是有人动过系统，或者装到了别处
      noCompiler:
        "This PC has no C# compiler: the helper is built with csc.exe from the .NET Framework that ships with Windows. If it's installed somewhere else, set DRAFTLESS_CSC to its path",
      needXcode:
        "Building the keyboard-hook helper needs the C# compiler that comes with Windows (csc.exe in the .NET Framework folder). If it's installed somewhere else, set DRAFTLESS_CSC to its path",
      buildFailed:
        "The keyboard-hook helper didn't build (if the C# compiler that comes with Windows is missing, set DRAFTLESS_CSC to it):\n{detail}",
    },
  },
};
