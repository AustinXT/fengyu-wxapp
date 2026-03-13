"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

const AvatarContext = React.createContext<{
  imageLoaded: boolean
  setImageLoaded: (loaded: boolean) => void
}>({ imageLoaded: false, setImageLoaded: () => {} })

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: number
}

function Avatar({ className, size = 40, style, children, ...props }: AvatarProps) {
  const [imageLoaded, setImageLoaded] = React.useState(false)

  return (
    <AvatarContext.Provider value={{ imageLoaded, setImageLoaded }}>
      <div
        className={cn(
          "relative flex shrink-0 overflow-hidden rounded-full bg-[var(--muted)]",
          className
        )}
        style={{ width: size, height: size, ...style }}
        {...props}
      >
        {children}
      </div>
    </AvatarContext.Provider>
  )
}

export interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {}

function AvatarImage({ className, src, alt = "", onLoad, onError, ...props }: AvatarImageProps) {
  const { setImageLoaded } = React.useContext(AvatarContext)

  const handleLoad = React.useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      setImageLoaded(true)
      onLoad?.(e)
    },
    [setImageLoaded, onLoad]
  )

  const handleError = React.useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      setImageLoaded(false)
      onError?.(e)
    },
    [setImageLoaded, onError]
  )

  if (!src) return null

  return (
    <img
      className={cn("aspect-square h-full w-full object-cover", className)}
      src={src}
      alt={alt}
      onLoad={handleLoad}
      onError={handleError}
      {...props}
    />
  )
}

export interface AvatarFallbackProps extends React.HTMLAttributes<HTMLSpanElement> {}

function AvatarFallback({ className, children, ...props }: AvatarFallbackProps) {
  const { imageLoaded } = React.useContext(AvatarContext)

  if (imageLoaded) return null

  return (
    <span
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-[var(--muted)] text-sm font-medium text-[var(--muted-foreground)]",
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export { Avatar, AvatarImage, AvatarFallback }
