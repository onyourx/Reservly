import { useEffect, useRef, useState, type ChangeEvent } from "react";

const PLACEHOLDERS = [
  "ref", "customerName", "customerEmail", "customerPhone", "store", "createdAt",
  "lines", "subtotal", "deposit", "idLast4", "signature", "date",
];

export function RichTextEditor({ value, onChange, disabled = false }: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);

  useEffect(() => {
    if (!source && editor.current && editor.current.innerHTML !== value) editor.current.innerHTML = value;
  }, [value, source]);

  const command = (name: string, argument?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, argument);
    if (editor.current) onChange(editor.current.innerHTML);
  };
  const insertLink = () => {
    const url = window.prompt("Link URL", "https://");
    if (url) command("createLink", url);
  };
  const insertImageUrl = () => {
    const url = window.prompt("Image URL", "https://");
    if (url) command("insertImage", url);
  };
  const uploadImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return window.alert("Choose an image file.");
    if (file.size > 500_000) return window.alert("Uploaded images must be smaller than 500 KB. Use an image URL for larger assets.");
    const reader = new FileReader();
    reader.onload = () => command("insertImage", String(reader.result));
    reader.readAsDataURL(file);
  };
  const insertPlaceholder = (key: string) => {
    if (!key) return;
    command("insertText", `{{${key}}}`);
  };

  if (source) {
    return (
      <div>
        <div className="rte-toolbar">
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setSource(false)}>Visual editor</button>
        </div>
        <textarea className="rte-source" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} rows={18} spellCheck={false} />
      </div>
    );
  }

  return (
    <div className={`rte ${disabled ? "disabled" : ""}`}>
      <div className="rte-toolbar">
        <select disabled={disabled} aria-label="Text style" defaultValue="" onChange={(e) => { command("formatBlock", e.target.value); e.target.value = ""; }}>
          <option value="">Style…</option><option value="p">Paragraph</option><option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option><option value="h3">Heading 3</option>
        </select>
        <button disabled={disabled} type="button" title="Bold" onClick={() => command("bold")}><strong>B</strong></button>
        <button disabled={disabled} type="button" title="Italic" onClick={() => command("italic")}><em>I</em></button>
        <button disabled={disabled} type="button" title="Underline" onClick={() => command("underline")}><u>U</u></button>
        <button disabled={disabled} type="button" title="Bulleted list" onClick={() => command("insertUnorderedList")}>• List</button>
        <button disabled={disabled} type="button" title="Numbered list" onClick={() => command("insertOrderedList")}>1. List</button>
        <button disabled={disabled} type="button" title="Align left" onClick={() => command("justifyLeft")}>←</button>
        <button disabled={disabled} type="button" title="Align center" onClick={() => command("justifyCenter")}>↔</button>
        <button disabled={disabled} type="button" title="Align right" onClick={() => command("justifyRight")}>→</button>
        <button disabled={disabled} type="button" onClick={insertLink}>Link</button>
        <button disabled={disabled} type="button" onClick={insertImageUrl}>Image URL</button>
        <label className="rte-upload">Upload image<input disabled={disabled} type="file" accept="image/*" onChange={uploadImage} /></label>
        <select disabled={disabled} aria-label="Insert booking field" defaultValue="" onChange={(e) => { insertPlaceholder(e.target.value); e.target.value = ""; }}>
          <option value="">Insert field…</option>
          {PLACEHOLDERS.map((key) => <option key={key} value={key}>{`{{${key}}}`}</option>)}
        </select>
        <button disabled={disabled} type="button" onClick={() => setSource(true)}>HTML</button>
      </div>
      <div
        ref={editor}
        className="rte-canvas"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={() => editor.current && onChange(editor.current.innerHTML)}
        data-placeholder="Design the rental contract here…"
      />
    </div>
  );
}
