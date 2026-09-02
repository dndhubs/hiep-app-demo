import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgrPlugin from 'vite-plugin-svgr';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		tsconfigPaths({
			parseNative: false
		}),
		svgrPlugin(),
		tailwindcss(),
	],
  	base: '/hiep-app-demo/', // ⚠️ MUST match your exact GitHub repository name
	build: {
		outDir: 'dist'
	},
	server: {
		host: '0.0.0.0',
		open: true,
		strictPort: false,
		port: 3000
	},
	define: {
		'import.meta.env.VITE_PORT': JSON.stringify(process.env.PORT || 3000),
		global: 'window'
	},
	resolve: {
		alias: {
			'@': '/src',
		}
	},
	optimizeDeps: {
		include: [
			'date-fns',
			'lodash'
		],
		exclude: [],
		esbuildOptions: {
			loader: {
				'.js': 'jsx'
			}
		}
	}
});
