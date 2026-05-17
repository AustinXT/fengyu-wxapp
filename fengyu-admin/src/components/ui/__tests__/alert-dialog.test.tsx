/**
 * AlertDialog component tests.
 *
 * Verifies the open/close lifecycle that previously raced under React 19 +
 * Next.js 15 (showModal() not firing reliably when `open` flipped true).
 *
 * happy-dom only partially implements <dialog>. In particular show()/showModal()
 * does NOT auto-toggle the `open` property in older versions, so we stub the
 * relevant methods on HTMLDialogElement to mirror real browser semantics.
 */
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '../alert-dialog'

beforeAll(() => {
  // Polyfill HTMLDialogElement so happy-dom faithfully mirrors browser behaviour.
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal: () => void
    show: () => void
    close: () => void
  }
  proto.showModal = function () {
    ;(this as unknown as HTMLDialogElement).setAttribute('open', '')
  }
  proto.show = function () {
    ;(this as unknown as HTMLDialogElement).setAttribute('open', '')
  }
  proto.close = function () {
    if (!(this as unknown as HTMLDialogElement).hasAttribute('open')) return
    ;(this as unknown as HTMLDialogElement).removeAttribute('open')
    ;(this as unknown as HTMLDialogElement).dispatchEvent(new Event('close'))
  }
})

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>open</button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTitle>Title</AlertDialogTitle>
        <AlertDialogDescription>Body</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="cancel" onClick={() => setOpen(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction data-testid="confirm" onClick={() => setOpen(false)}>
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </>
  )
}

describe('AlertDialog', () => {
  it('calls showModal() when the parent flips open=true via setState', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')

    const { getByTestId, container } = render(<Harness />)

    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(false)

    act(() => {
      getByTestId('trigger').click()
    })

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true)
  })

  it('does not call showModal again if the dialog is already open across re-renders', () => {
    // The component guards with `if (!dialog.open) dialog.showModal()`, so even
    // when the effect re-runs (StrictMode double-fire, React 19 concurrent
    // re-commit), showModal must not be re-invoked on an already-open dialog.
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const { rerender, container } = render(
      <AlertDialog open={true} onOpenChange={() => {}}>
        <AlertDialogTitle>T</AlertDialogTitle>
      </AlertDialog>,
    )
    const initialCalls = showModal.mock.calls.length
    expect(initialCalls).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true)

    rerender(
      <AlertDialog open={true} onOpenChange={() => {}}>
        <AlertDialogTitle>T-updated</AlertDialogTitle>
      </AlertDialog>,
    )
    // Re-render with same open=true should NOT trigger another showModal call,
    // because the dialog already has `open` attribute set.
    expect(showModal).toHaveBeenCalledTimes(initialCalls)
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true)
  })

  it('calls close() when open flips back to false', () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close')
    const { rerender, container } = render(
      <AlertDialog open={true} onOpenChange={() => {}}>
        <AlertDialogTitle>T</AlertDialogTitle>
      </AlertDialog>,
    )
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true)

    rerender(
      <AlertDialog open={false} onOpenChange={() => {}}>
        <AlertDialogTitle>T</AlertDialogTitle>
      </AlertDialog>,
    )

    expect(close).toHaveBeenCalledTimes(1)
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(false)
  })

  it('forwards the native close event to onOpenChange(false)', () => {
    const onOpenChange = vi.fn()
    const { container } = render(
      <AlertDialog open={true} onOpenChange={onOpenChange}>
        <AlertDialogTitle>T</AlertDialogTitle>
      </AlertDialog>,
    )
    const dialog = container.querySelector('dialog') as HTMLDialogElement
    act(() => {
      dialog.close()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('falls back to .show() if showModal throws (Playwright / sandbox edge case)', () => {
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, 'showModal')
      .mockImplementation(function (this: HTMLDialogElement) {
        throw new Error('InvalidStateError')
      })
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show')

    const { container } = render(
      <AlertDialog open={true} onOpenChange={() => {}}>
        <AlertDialogTitle>T</AlertDialogTitle>
      </AlertDialog>,
    )

    expect(showModal).toHaveBeenCalled()
    expect(show).toHaveBeenCalled()
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true)
  })

  it('does NOT prevent clicks on inner buttons (regression: backdrop logic swallowing inner clicks)', () => {
    // Reproduces the suspected real bug: original handleBackdropClick measured the
    // dialog rect, and when the dialog had just opened (rect not yet committed)
    // or the click landed on a child, the old code could call preventDefault and
    // swallow the click. The fix only treats e.target === dialog as a backdrop hit.
    const onConfirm = vi.fn()
    const { container } = render(
      <AlertDialog open={true} onOpenChange={() => {}}>
        <AlertDialogTitle>T</AlertDialogTitle>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>,
    )
    const confirmBtn = container.querySelector('button') as HTMLButtonElement
    act(() => {
      confirmBtn.click()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
