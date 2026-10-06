<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷处置 / 现场巡视隐患清单</h2>
        <p class="page-desc">
          登记重复只认第一次取值，后到的按重复处理；确认消除的处理结论回写隐患清单，
          导出清单条数与页面完全一致；环节按顺序推进，跳级拦下。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记设备缺陷</button>
        <button class="btn" type="button" @click="showMigration = true">历史数据缺失字段</button>
        <button class="btn" type="button" @click="doExportHazards">导出隐患清单（{{ view.stats.hazardCount }} 条）</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待处理</span>
        <strong class="stat-value">{{ view.stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">处理中</span>
        <strong class="stat-value">{{ view.stats.handling }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已消除</span>
        <strong class="stat-value">{{ view.stats.resolved }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">隐患清单条数（页面=导出）</span>
        <strong class="stat-value">{{ view.stats.hazardCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">重复上报（只认第一次）</span>
        <strong class="stat-value">{{ view.stats.duplicate }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>编号 / 设备 / 描述 / 处理人</span>
        <input v-model="filters.keyword" placeholder="按关键字检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <h3 class="section-title">
      缺陷明细（{{ view.all.length }} 条）
      <span class="hint">重复登记不覆盖既有取值，只在记录上标注重复来源</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>缺陷编号</th><th>设备名称</th><th>缺陷描述</th><th>等级</th>
          <th>业务日期</th><th>处理期限</th><th>处理人员</th><th>状态</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in view.all" :key="row.id">
          <td>
            {{ row.缺陷编号 }}
            <span v-if="row.conclusion?.writtenHazardId" class="tag ok">已回写隐患 #{{ row.conclusion.writtenHazardId }}</span>
          </td>
          <td>{{ row.设备名称 }}</td>
          <td>{{ row.缺陷描述 }}</td>
          <td>{{ row.缺陷等级 || '暂无数据（历史缺失）' }}</td>
          <td>{{ row.发现日期 }}</td>
          <td>{{ row.处理期限 || '暂无数据（历史缺失）' }}</td>
          <td>{{ row.处理人员 || '暂无数据（历史缺失）' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions" style="flex-direction: column; align-items: flex-start;">
            <template v-for="act in nextActions(row.status)" :key="act.target">
              <button
                class="link"
                type="button"
                :disabled="!act.enabled"
                :title="act.reason"
                @click="onAdvance(row, act.target)"
              >
                {{ act.label }}
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!view.all.length">
          <td colspan="9" class="empty-state">暂无缺陷处置数据，可先登记设备缺陷</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">
      重复上报留痕（{{ view.duplicates.length }} 条）
      <span class="hint">后到的重复登记不覆盖第一次取值，统一按重复处理</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr><th>留痕号</th><th>命中既有缺陷</th><th>上报人</th><th>时间</th><th>重复原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in view.duplicates" :key="d.id">
          <td>#{{ d.id }}</td>
          <td>{{ d.recordNo }}</td>
          <td>{{ d.attemptedBy }}</td>
          <td>{{ formatTime(d.at) }}</td>
          <td>{{ d.reason }}</td>
        </tr>
        <tr v-if="!view.duplicates.length">
          <td colspan="5" class="empty-state">暂无重复上报记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">
      现场巡视隐患清单（{{ view.hazards.length }} 条）
      <span class="hint">只由「确认消除」回写产生，导出条数与这里一致</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>隐患号</th><th>来源缺陷</th><th>业务日期</th><th>设备名称</th>
          <th>缺陷描述</th><th>等级</th><th>处理结论</th><th>处理人</th><th>处理时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="h in view.hazards" :key="h.id">
          <td>#{{ h.id }}</td>
          <td>{{ h.sourceDefectNo }}</td>
          <td>{{ h.业务日期 }}</td>
          <td>{{ h.设备名称 }}</td>
          <td>{{ h.缺陷描述 }}</td>
          <td>{{ h.缺陷等级 }}</td>
          <td>{{ h.conclusion }}</td>
          <td>{{ h.handler }}</td>
          <td>{{ formatTime(h.handledAt) }}</td>
        </tr>
        <tr v-if="!view.hazards.length">
          <td colspan="9" class="empty-state">暂无隐患记录：在「处理中」的缺陷上确认消除后，结论会回写到这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>缺陷 {{ view.all.length }} 条 · 重复上报 {{ view.duplicates.length }} 条 · 隐患清单 {{ view.hazards.length }} 条（导出行数相同）</span>
      <span v-if="message" :class="messageOk ? 'success-box' : 'error-text'" style="padding: 2px 8px;">{{ message }}</span>
    </footer>

    <!-- 登记 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal" style="width: 620px;">
        <h3>登记设备缺陷</h3>
        <p class="page-desc">
          重复口径：缺陷编号相同，或 设备名称＋业务日期＋缺陷描述 完全相同。命中重复只认第一次取值，本次按重复处理；
          网络重试不会重复登记。
        </p>
        <div class="form-grid">
          <div class="form-field"><label>缺陷编号</label><input v-model="form.缺陷编号" /></div>
          <div class="form-field"><label>设备名称</label><input v-model="form.设备名称" /></div>
          <div class="form-field" style="grid-column: 1 / 3;"><label>缺陷描述</label><textarea v-model="form.缺陷描述" rows="2"></textarea></div>
          <div class="form-field">
            <label>缺陷等级</label>
            <select v-model="form.缺陷等级"><option>一般</option><option>重大</option><option>紧急</option></select>
          </div>
          <div class="form-field"><label>业务日期（发现日期）</label><input v-model="form.发现日期" type="date" /></div>
          <div class="form-field"><label>处理期限</label><input v-model="form.处理期限" type="date" /></div>
          <div class="form-field"><label>上报人</label><input v-model="form.reporter" /></div>
        </div>
        <div v-if="formNotice" :class="formOk ? 'success-box' : 'blocked-box'">{{ formNotice }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
          <button class="btn" type="button" @click="submitOnce">重试提交（上一次已落库则回放，不重复登记）</button>
          <button class="btn primary" type="button" @click="submitOnce">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 确认消除 -->
    <div v-if="resolveTarget" class="modal-mask" @click.self="resolveTarget = null">
      <div class="modal" style="width: 560px;">
        <h3>确认消除 — {{ resolveTarget.缺陷编号 }}</h3>
        <p class="page-desc">处理结论将回写到现场巡视隐患清单。</p>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>处理结论</label>
          <textarea v-model="resolveResult" rows="3" placeholder="例如：更换冷却器密封件，渗油消除，复测正常"></textarea>
        </div>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>处理人员</label>
          <input v-model="resolveHandler" />
        </div>
        <div v-if="resolveMsg" class="error-text">{{ resolveMsg }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="resolveTarget = null">取消</button>
          <button class="btn primary" type="button" @click="confirmResolve">确认消除并回写隐患清单</button>
        </div>
      </div>
    </div>

    <!-- 历史缺失字段 -->
    <div v-if="showMigration" class="modal-mask" @click.self="showMigration = false">
      <div class="modal" style="width: 680px;">
        <h3>历史数据补数：缺陷缺失字段</h3>
        <div class="notice-box">
          历史数据按业务日期（发现日期）升序补数；空串、--、null 等判为缺失，不伪造默认值，缺失字段单独罗列。
        </div>
        <table class="data-table">
          <thead><tr><th>缺陷编号</th><th>业务日期</th><th>缺失字段</th></tr></thead>
          <tbody>
            <tr v-for="issue in defectMigrationIssues" :key="issue.recordNo">
              <td>{{ issue.recordNo }}</td>
              <td>{{ issue.businessDate }}</td>
              <td>{{ issue.fields.join('、') }}</td>
            </tr>
            <tr v-if="!defectMigrationIssues.length"><td colspan="3" class="empty-state">历史缺陷无缺失字段</td></tr>
          </tbody>
        </table>
        <div class="modal-foot"><button class="btn" type="button" @click="showMigration = false">关闭</button></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { advanceDefect, registerDefect, resolveDefect } from '@/domain/defect-service'
import { defectView, exportHazards, migrationView } from '@/domain/views'
import type { DefectRecord, DefectStatus } from '@/domain/types'

const statuses: DefectStatus[] = ['待处理', '处理中', '已消除', '已挂账']
const view = ref(defectView({ keyword: '', status: '' }))
const filters = reactive({ keyword: '', status: '' })
const message = ref('')
const messageOk = ref(true)
const showMigration = ref(false)

const showCreate = ref(false)
const form = reactive({
  缺陷编号: '',
  设备名称: '',
  缺陷描述: '',
  缺陷等级: '一般',
  发现日期: new Date().toISOString().slice(0, 10),
  处理期限: '',
  处理人员: '',
  reporter: '',
  clientToken: '',
})
const formNotice = ref('')
const formOk = ref(false)

const resolveTarget = ref<DefectRecord | null>(null)
const resolveResult = ref('')
const resolveHandler = ref('')
const resolveMsg = ref('')

const defectMigrationIssues = ref(migrationView().filter((i) => i.module === 'defect'))

function reload() {
  view.value = defectView({ keyword: filters.keyword, status: filters.status })
}
onMounted(reload)

function formatTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : iso
}

function nextActions(status: DefectStatus) {
  const defs: { target: DefectStatus; label: string; enabled: boolean; reason: string }[] = []
  if (status === '待处理') {
    defs.push({ target: '处理中', label: '派发处理', enabled: true, reason: '' })
    // 置灰的跳级按钮，明确提示缺哪一步
    defs.push({ target: '已消除', label: '确认消除', enabled: false, reason: '跳级：需先派发处理到「处理中」' })
  } else if (status === '处理中') {
    defs.push({ target: '已消除', label: '确认消除（回写隐患清单）', enabled: true, reason: '' })
    defs.push({ target: '已挂账', label: '登记挂账', enabled: true, reason: '' })
  }
  return defs
}

function onAdvance(row: DefectRecord, target: DefectStatus) {
  if (target === '已消除') {
    resolveTarget.value = row
    resolveResult.value = ''
    resolveHandler.value = row.处理人员
    resolveMsg.value = ''
    return
  }
  const res = advanceDefect(row.id, target)
  message.value = res.message
  messageOk.value = res.ok
  reload()
}

function confirmResolve() {
  if (!resolveTarget.value) return
  const res = resolveDefect(resolveTarget.value.id, {
    result: resolveResult.value,
    handler: resolveHandler.value,
  })
  resolveMsg.value = res.ok ? '' : res.message
  if (res.ok) {
    message.value = res.message
    messageOk.value = true
    resolveTarget.value = null
    reload()
  }
}

function openCreate() {
  Object.assign(form, {
    缺陷编号: `DEFE-${String(Math.floor(1000 + Math.random() * 9000))}`,
    设备名称: '',
    缺陷描述: '',
    缺陷等级: '一般',
    发现日期: new Date().toISOString().slice(0, 10),
    处理期限: '',
    处理人员: '',
    reporter: '',
    clientToken: `defect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })
  formNotice.value = ''
  showCreate.value = true
}

function submitOnce() {
  // 同一 clientToken：第一次成功落库后，再点就是重试回放，不会重复登记
  const outcome = registerDefect({
    缺陷编号: form.缺陷编号,
    设备名称: form.设备名称,
    缺陷描述: form.缺陷描述,
    缺陷等级: form.缺陷等级,
    发现日期: form.发现日期,
    处理期限: form.处理期限,
    处理人员: form.处理人员,
    reporter: form.reporter,
    clientToken: form.clientToken,
  })
  formOk.value = outcome.ok
  formNotice.value = outcome.message
  if (outcome.ok && outcome.mode === 'created') {
    setTimeout(() => {
      showCreate.value = false
    }, 800)
  }
  reload()
}

function doExportHazards() {
  exportHazards(view.value)
}
</script>
