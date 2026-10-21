'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

const KEY = 'cctvhub-theme'

export function ThemeSwitcher() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    // Read after mount so server and browser first render the same thing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light')
    } catch {
      // Storage can be blocked; the theme then lasts only for this visit.
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
