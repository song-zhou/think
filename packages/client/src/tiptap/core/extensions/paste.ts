import { Extension } from '@tiptap/core';
import { safeJSONParse } from 'helpers/json';
import { toggleMark } from 'prosemirror-commands';
import { Fragment, Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { EXTENSION_PRIORITY_HIGHEST } from 'tiptap/core/constants';
import {
  debug,
  handleFileEvent,
  isInCode,
  isMarkdown,
  isTitleNode,
  isValidURL,
  LANGUAGES,
  normalizeMarkdown,
} from 'tiptap/prose-utils';

import { TitleExtensionName } from './title';

interface IPasteOptions {
  /**
   *
   * 将 markdown 转换为 html
   */
  markdownToHTML: (arg: string) => string;

  /**
   * 将 markdown 转换为 prosemirror 节点
   * FIXME: prosemirror 节点的类型是什么？
   */
  markdownToProsemirror: (arg: { schema: Schema; content: string; needTitle: boolean }) => unknown;

  /**
   * 将 prosemirror 转换为 markdown
   */
  prosemirrorToMarkdown: (arg: { content: Fragment }) => string;
}

export const Paste = Extension.create<IPasteOptions>({
  name: 'paste',
  priority: EXTENSION_PRIORITY_HIGHEST,

  addOptions() {
    return {
      markdownToHTML: (arg) => arg,
      markdownToProsemirror: (arg) => arg.content,
      prosemirrorToMarkdown: (arg) => String(arg.content),
    };
  },

  addStorage() {
    return this.options;
  },

  addProseMirrorPlugins() {
    const extensionThis = this;
    const { editor } = extensionThis;

    return [
      new Plugin({
        key: new PluginKey('paste'),
        props: {
          handlePaste: (view, event: ClipboardEvent) => {
            if (view.props.editable && !view.props.editable(view.state)) {
              return false;
            }

            if (!event.clipboardData) return false;

            // 文件
            const files = Array.from(event.clipboardData.files);
            if (files.length) {
              event.preventDefault();
              files.forEach((file) => {
                handleFileEvent({ editor, file });
              });
              return true;
            }

            const text = event.clipboardData.getData('text/plain');
            const html = event.clipboardData.getData('text/html');
            const vscode = event.clipboardData.getData('vscode-editor-data');
            const node = event.clipboardData.getData('text/node');
            const markdownText = event.clipboardData.getData('text/markdown');
            const { state, dispatch } = view;

            debug(() => {
              console.group('paste');
              console.log({ text, vscode, node, markdownText });
              console.log(html);
              console.groupEnd();
            });

            const { markdownToProsemirror } = extensionThis.options;

            // 直接复制节点
            if (node) {
              const json = safeJSONParse(node);
              const tr = view.state.tr;
              const selection = tr.selection;
              view.dispatch(tr.insert(selection.from - 1, view.state.schema.nodeFromJSON(json)).scrollIntoView());
              return true;
            }

            // 链接
            if (isValidURL(text)) {
              if (!state.selection.empty) {
                toggleMark(this.editor.schema.marks.link, { href: text })(state, dispatch);
                return true;
              }

              const transaction = view.state.tr
                .insertText(text, state.selection.from, state.selection.to)
                .addMark(
                  state.selection.from,
                  state.selection.to + text.length,
                  state.schema.marks.link.create({ href: text })
                );
              view.dispatch(transaction);
              return true;
            }

            // 粘贴代码
            if (isInCode(view.state)) {
              event.preventDefault();
              view.dispatch(view.state.tr.insertText(text).scrollIntoView());
              return true;
            }

            const vscodeMeta = vscode ? JSON.parse(vscode) : undefined;
            const pasteCodeLanguage = vscodeMeta?.mode;

            if (pasteCodeLanguage && pasteCodeLanguage !== 'markdown') {
              event.preventDefault();
              view.dispatch(
                view.state.tr
                  .replaceSelectionWith(
                    view.state.schema.nodes.codeBlock.create({
                      language: Object.keys(LANGUAGES).includes(vscodeMeta.mode) ? vscodeMeta.mode : null,
                    })
                  )
                  .insertText(text)
              );
              return true;
            }

            // 处理 markdown
            if (markdownText || isMarkdown(text) || html.length === 0 || pasteCodeLanguage === 'markdown') {
              event.preventDefault();
              const firstNode = view.props.state.doc.content.firstChild;
              const hasTitleExtension = !!editor.extensionManager.extensions.find(
                (extension) => extension.name === TitleExtensionName
              );
              const hasTitle = isTitleNode(firstNode) && firstNode.content.size > 0;
              const schema = view.props.state.schema;
              const doc = markdownToProsemirror({
                schema,
                content: normalizeMarkdown(markdownText || text),
                needTitle: hasTitleExtension && !hasTitle,
              });

              let tr = view.state.tr;
              const selection = tr.selection;
              view.state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
                const startPosition = hasTitle ? Math.min(position, selection.from) : 0;
                const endPosition = Math.min(position + node.nodeSize, selection.to);
                tr = tr.replaceWith(startPosition, endPosition, view.state.schema.nodeFromJSON(doc));
              });
              view.dispatch(tr.scrollIntoView());
              return true;
            }

            if (text.length !== 0) {
              event.preventDefault();
              view.dispatch(view.state.tr.insertText(text));
              return true;
            }

            return false;
          },
          handleDrop: (view, event: any) => {
            if (view.props.editable && !view.props.editable(view.state)) {
              return false;
            }

            const hasFiles = event.dataTransfer.files.length > 0;
            if (!hasFiles) return false;

            event.preventDefault();

            const files = Array.from(event.dataTransfer.files);
            if (files.length) {
              event.preventDefault();
              files.forEach((file: File) => {
                handleFileEvent({ editor, file });
              });
              return true;
            }

            return false;
          },
        },
      }),
    ];
  },
});
