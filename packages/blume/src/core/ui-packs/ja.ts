import type { UIStringsOverride } from "../i18n-ui.ts";

/** Japanese (ja) UI strings. */
export const ja: UIStringsOverride = {
  actions: {
    addToCursor: "Cursor に追加",
    addToVscode: "VS Code に追加",
    askAI: "このページについて AI に質問",
    connectMcp: "MCP に接続",
    copied: "コピーしました！",
    copyClaudeCode: "Claude Code コマンドをコピー",
    copyMarkdown: "Markdown としてコピー",
    copyServerUrl: "サーバー URL をコピー",
    edit: "GitHub で編集",
    openInChat: "チャットで開く",
    scrollToTop: "トップに戻る",
  },
  ask: {
    empty: "ドキュメントについて質問してください。",
    error: "申し訳ありません。問題が発生しました。",
    label: "質問する",
    placeholder: "質問を入力…",
    send: "送信",
    title: "AI に質問",
  },
  banner: { dismiss: "お知らせを閉じる" },
  changelog: {
    description: "製品のアップデートとリリースノート。",
    title: "変更履歴",
  },
  feedback: {
    no: "いいえ",
    question: "このページは役に立ちましたか？",
    thanks: "フィードバックありがとうございます！",
    yes: "はい",
  },
  languageSwitcher: { label: "言語", untranslated: "未翻訳" },
  nav: { breadcrumb: "パンくずリスト" },
  page: {
    lastUpdated: "最終更新",
    next: "次へ",
    pagination: "ページネーション",
    previous: "前へ",
    skipToContent: "コンテンツにスキップ",
  },
  search: {
    all: "すべて",
    button: "検索",
    devOnly: "検索は本番ビルドで利用できます。",
    label: "ドキュメントを検索",
    noResults: "結果が見つかりませんでした。",
    placeholder: "ドキュメントを検索…",
  },
  toc: { title: "このページの内容" },
};
