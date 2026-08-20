<template>
  <div class="relative flex flex-col gap-3 text-sm">
    <div class="mt-1 flex h-6 items-center gap-2 px-1 leading-6">
      <div class="indicator">
        <span
          v-if="isUIUpdateAvailable"
          class="indicator-item top-1 -right-1 flex"
        >
          <span class="bg-secondary absolute h-2 w-2 animate-ping rounded-full"></span>
          <span class="bg-secondary h-2 w-2 rounded-full"></span>
        </span>
        <a
          href="https://github.com/wawnnzxd/zashboard"
          target="_blank"
          class="text-lg leading-6 font-semibold"
        >
          <!-- 渐变字标只作用于品牌名;版本号普通无衬线、极小号、低灰度,勉强可见即可 -->
          <span class="desire-wordmark">Desire</span>
          <span class="text-base-content/35 ml-1 align-middle font-sans text-[10px] font-normal">
            {{ zashboardVersion }}
            <span
              v-if="commitId"
              class="text-[9px]"
            >
              {{ commitId }}
            </span>
          </span>
        </a>
      </div>
    </div>

    <StyleSettings />
    <GeneralSettings />
  </div>
</template>

<script setup lang="ts">
import { isUIUpdateAvailable, zashboardVersion } from '@/assembly/version'
import GeneralSettings from './GeneralSettings.vue'
import StyleSettings from './StyleSettings.vue'

const commitId = __COMMIT_ID__
</script>
