/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 跟 h3-video.linode.fun 一致的暗色品牌色
        bg: { DEFAULT: '#0a0a0f', card: '#15151d', hover: '#1f1f2b' },
        accent: { DEFAULT: '#6366f1', glow: '#818cf8' },
        ok: '#10b981',
        warn: '#f59e0b',
        err: '#ef4444',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        slideUp: { '0%': { transform: 'translateY(20px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
      },
    },
  },
  plugins: [],
}
