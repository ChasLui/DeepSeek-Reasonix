import { useState, useCallback } from "preact/hooks";

export interface LineComment {
  id: string;
  file: string;
  lineNumber: number;
  content: string;
  timestamp: number;
}

export interface LineCommentDraft {
  file: string;
  lineNumber: number;
  content: string;
  editingId?: string;
}

export interface LineCommentsState {
  comments: LineComment[];
  draft: LineCommentDraft | null;
  addComment: (file: string, lineNumber: number, content: string) => void;
  updateComment: (id: string, content: string) => void;
  deleteComment: (id: string) => void;
  startDraft: (file: string, lineNumber: number) => void;
  editComment: (id: string, content: string) => void;
  cancelDraft: () => void;
  setDraftContent: (content: string) => void;
  submitDraft: () => void;
  commentsForFile: (file: string) => LineComment[];
  commentsForLine: (file: string, lineNumber: number) => LineComment[];
}

export function useLineComments(): LineCommentsState {
  const [comments, setComments] = useState<LineComment[]>([]);
  const [draft, setDraft] = useState<LineCommentDraft | null>(null);

  const addComment = useCallback((file: string, lineNumber: number, content: string) => {
    const id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setComments((prev) => [...prev, { id, file, lineNumber, content, timestamp: Date.now() }]);
    setDraft(null);
  }, []);

  const updateComment = useCallback((id: string, content: string) => {
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, content } : c)));
  }, []);

  const deleteComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const startDraft = useCallback((file: string, lineNumber: number) => {
    setDraft({ file, lineNumber, content: "" });
  }, []);

  const editComment = useCallback(
    (id: string, content: string) => {
      const comment = comments.find((c) => c.id === id);
      if (comment) {
        setDraft({ file: comment.file, lineNumber: comment.lineNumber, content, editingId: id });
      }
    },
    [comments],
  );

  const cancelDraft = useCallback(() => {
    setDraft(null);
  }, []);

  const setDraftContent = useCallback((content: string) => {
    setDraft((prev) => (prev ? { ...prev, content } : null));
  }, []);

  const submitDraft = useCallback(() => {
    if (draft && draft.content.trim()) {
      if (draft.editingId) {
        updateComment(draft.editingId, draft.content.trim());
      } else {
        addComment(draft.file, draft.lineNumber, draft.content.trim());
      }
      setDraft(null);
    }
  }, [draft, addComment, updateComment]);

  const commentsForFile = useCallback(
    (file: string) => comments.filter((c) => c.file === file),
    [comments],
  );

  const commentsForLine = useCallback(
    (file: string, lineNumber: number) =>
      comments.filter((c) => c.file === file && c.lineNumber === lineNumber),
    [comments],
  );

  return {
    comments: comments,
    draft: draft,
    addComment: addComment,
    updateComment: updateComment,
    deleteComment: deleteComment,
    startDraft: startDraft,
    editComment: editComment,
    cancelDraft: cancelDraft,
    setDraftContent: setDraftContent,
    submitDraft: submitDraft,
    commentsForFile: commentsForFile,
    commentsForLine: commentsForLine,
  };
}
