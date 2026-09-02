"use client";
import { useEffect, useRef } from "react";
import { bridge } from "./bridge";

/**
 * Subscribes to the runtime event bus for the lifetime of a component.
 * @param {(evt: {type: string, payload: object, timestamp: number}) => void} handler
 */
export function useRuntimeEvents(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = bridge.events.subscribe((evt) => handlerRef.current(evt));
    return unsubscribe;
  }, []);
}
