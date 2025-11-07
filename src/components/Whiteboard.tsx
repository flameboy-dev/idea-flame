import React, { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Point { x: number; y: number; }

interface Stroke {
  id: string;
  points: Point[];
  color: string;
  size: number;
  tool: string;
  userId: string;
}

interface RemoteCursor {
  userId: string;
  userName: string;
  userColor: string;
  x: number;
  y: number;
  timestamp: number;
}

interface WhiteboardProps {
  roomId: string;
  userId: string;
  userName: string;
  userColor: string;
  currentTool: string;
  currentColor: string;
  brushSize: number;
  onClear: () => void;
}

export const Whiteboard = ({
  roomId,
  userId,
  userName,
  userColor,
  currentTool,
  currentColor,
  brushSize,
  onClear,
}: WhiteboardProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Map<string, RemoteCursor>>(new Map());
  const cursorChannel = useRef<any>(null);

  // transient drawing state
  const isDrawingRef = useRef(false);
  const currentPointsRef = useRef<Point[] | null>(null);

  // keep strokes in a ref for event handlers
  const strokesRef = useRef<Stroke[]>([]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);

  // --- NEW: refs for tool/color/size so pointer handlers always use latest values ---
  const currentColorRef = useRef(currentColor);
  const currentToolRef = useRef(currentTool);
  const brushSizeRef = useRef(brushSize);

  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);
  useEffect(() => { currentToolRef.current = currentTool; }, [currentTool]);
  useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
  // -------------------------------------------------------------------------------

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    redrawAll();
  }, []);

  const loadStrokes = useCallback(async () => {
    const { data, error } = await supabase
      .from("whiteboard_strokes")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error loading strokes:", error);
      return;
    }

    if (data) {
      const parsed = data.map((s) => ({
        id: s.id,
        points: (s.points as unknown) as Point[],
        color: s.color,
        size: s.size,
        tool: s.tool,
        userId: s.user_id,
      })) as Stroke[];
      setStrokes(parsed);
    } else {
      setStrokes([]);
    }
  }, [roomId]);

  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1e293b";
    const rect = canvas.getBoundingClientRect();
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // persisted strokes
    for (const stroke of strokesRef.current) {
      if (!stroke.points || stroke.points.length < 2) continue;
      if (stroke.tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = stroke.color;
      }
      ctx.lineWidth = stroke.size;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // transient stroke (uses latest props via refs)
    const pending = currentPointsRef.current;
    if (pending && pending.length >= 2) {
      ctx.beginPath();
      if (currentToolRef.current === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = currentColorRef.current;
      }
      ctx.lineWidth = brushSizeRef.current;
      ctx.moveTo(pending[0].x, pending[0].y);
      for (let i = 1; i < pending.length; i++) {
        ctx.lineTo(pending[i].x, pending[i].y);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }

    // remote cursors
    remoteCursors.forEach((cursor) => {
      ctx.fillStyle = cursor.userColor;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "12px Inter, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(cursor.userName, cursor.x + 12, cursor.y + 4);
    });

    ctx.restore();
  }, [remoteCursors]);

  // realtime strokes subscription
  useEffect(() => {
    if (!roomId) return;
    const channel = supabase
      .channel(`whiteboard:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "whiteboard_strokes",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const newStroke: Stroke = {
            id: payload.new.id,
            points: payload.new.points,
            color: payload.new.color,
            size: payload.new.size,
            tool: payload.new.tool,
            userId: payload.new.user_id,
          };
          setStrokes((prev) => {
            const next = [...prev, newStroke];
            strokesRef.current = next;
            return next;
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "whiteboard_strokes",
        },
        () => {
          setStrokes([]);
          strokesRef.current = [];
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  // presence / cursors (kept original)
  useEffect(() => {
    cursorChannel.current = supabase.channel(`cursors:${roomId}`);

    cursorChannel.current
      .on("presence", { event: "sync" }, () => {
        const state = cursorChannel.current.presenceState();
        const cursors = new Map<string, RemoteCursor>();

        Object.keys(state).forEach((key) => {
          const presences = state[key];
          if (presences && presences.length > 0) {
            const presence = presences[0];
            if (presence.user_id !== userId) {
              cursors.set(presence.user_id, {
                userId: presence.user_id,
                userName: presence.user_name,
                userColor: presence.user_color,
                x: presence.x,
                y: presence.y,
                timestamp: presence.timestamp,
              });
            }
          }
        });
        setRemoteCursors(cursors);
      })
      .subscribe(async (status: string) => {
        if (status === "SUBSCRIBED") {
          await cursorChannel.current.track({
            user_id: userId,
            user_name: userName,
            user_color: userColor,
            x: 0,
            y: 0,
            timestamp: Date.now(),
          });
        }
      });

    return () => {
      if (cursorChannel.current) {
        supabase.removeChannel(cursorChannel.current);
      }
    };
  }, [roomId, userId, userName, userColor]);

  useEffect(() => {
    strokesRef.current = strokes;
    redrawAll();
  }, [strokes, redrawAll]);

  useEffect(() => { redrawAll(); }, [remoteCursors, redrawAll]);

  useEffect(() => {
    loadStrokes();
    resizeCanvas();
    const ro = new ResizeObserver(() => resizeCanvas());
    const container = containerRef.current;
    if (container) ro.observe(container);
    window.addEventListener("orientationchange", resizeCanvas);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", resizeCanvas);
    };
  }, [loadStrokes, resizeCanvas]);

  const getPointFromEvent = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y };
  };

  // draw only the new segment — now uses refs for latest tool/color/size
  const drawSegment = (from: Point, to: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    if (currentToolRef.current === "eraser") ctx.globalCompositeOperation = "destination-out";
    else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = currentColorRef.current;
    }
    ctx.lineWidth = brushSizeRef.current;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handlePointerDown = (ev: PointerEvent) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
      isDrawingRef.current = true;
      const pt = getPointFromEvent(ev.clientX, ev.clientY);
      currentPointsRef.current = [pt];
    };

    const handlePointerMove = (ev: PointerEvent) => {
      const pt = getPointFromEvent(ev.clientX, ev.clientY);

      if (cursorChannel.current) {
        cursorChannel.current.track({
          user_id: userId,
          user_name: userName,
          user_color: userColor,
          x: pt.x,
          y: pt.y,
          timestamp: Date.now(),
        });
      }

      if (!isDrawingRef.current || !currentPointsRef.current) return;

      const pending = currentPointsRef.current;
      const prev = pending[pending.length - 1];
      pending.push(pt);
      drawSegment(prev, pt);
    };

    const commitStroke = async () => {
      if (!currentPointsRef.current || currentPointsRef.current.length === 0) return;
      const points = currentPointsRef.current;
      const tempId = `local-${Date.now()}`;
      const localStroke: Stroke = {
        id: tempId,
        points,
        color: currentColorRef.current,
        size: brushSizeRef.current,
        tool: currentToolRef.current,
        userId,
      };

      setStrokes((prev) => {
        const next = [...prev, localStroke];
        strokesRef.current = next;
        return next;
      });

      const { error } = await supabase.from("whiteboard_strokes").insert([{
        room_id: roomId,
        user_id: userId,
        user_name: userName,
        user_color: userColor,
        points: points as any,
        color: currentColorRef.current,
        size: brushSizeRef.current,
        tool: currentToolRef.current,
      }]);

      if (error) {
        console.error("Error saving stroke:", error);
      }

      currentPointsRef.current = null;
    };

    const handlePointerUp = (ev: PointerEvent) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      (ev.target as Element).releasePointerCapture?.(ev.pointerId);
      commitStroke();
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [roomId, userId, userName, userColor]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas
        ref={canvasRef}
        className="border border-border rounded-lg cursor-crosshair w-full h-full"
        style={{ touchAction: "none", display: "block" }}
      />
    </div>
  );
};
