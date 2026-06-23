import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";

export interface ProgressSinkRef {
  current:
    | ((info: {
        toolName: string;
        progress: number;
        total?: number | undefined;
        message?: string | undefined;
      }) => void)
    | null;
}

type ToolProgress = {
  progress: number;
  total?: number | undefined;
  message?: string | undefined;
};

export interface ToolProgressDisplay {
  ongoingTool: { name: string; args?: string } | null;
  setOngoingTool: Dispatch<SetStateAction<{ name: string; args?: string } | null>>;
  toolProgress: ToolProgress | null;
  setToolProgress: Dispatch<SetStateAction<ToolProgress | null>>;
  statusLine: string | null;
  setStatusLine: Dispatch<SetStateAction<string | null>>;
  /** Clears all three — call from the turn-end `finally`. */
  clear: () => void;
}

export function useToolProgressDisplay(progressSink?: ProgressSinkRef): ToolProgressDisplay {
  const [ongoingTool, setOngoingTool] = useState<{ name: string; args?: string } | null>(null);
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  useEffect(() => {
    if (!progressSink) return;
    progressSink.current = (info) => {
      setToolProgress({
        progress: info.progress,
        ...(info.total !== undefined ? { total: info.total } : {}),
        ...(info.message !== undefined ? { message: info.message } : {}),
      });
    };
    return () => {
      if (progressSink.current) progressSink.current = null;
    };
  }, [progressSink]);

  const clear = useCallback(() => {
    setOngoingTool(null);
    setToolProgress(null);
    setStatusLine(null);
  }, []);

  return {
    ongoingTool,
    setOngoingTool,
    toolProgress,
    setToolProgress,
    statusLine,
    setStatusLine,
    clear,
  };
}
