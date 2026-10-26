// Explicit production ports. Update the affected contract before implementation.
export const APPLICATION_SERVICE_CONTRACTS = Object.freeze({
  lifecycle: Object.freeze({
    provides: Object.freeze(["clearPrompt","wakeChatFollower","startChatTracking","followCurrentChat","rememberModuleSources","sourceEventRelevant","settledHistoryTail","localPersonaHistoryState","open","stop","disable"]),
    requires: Object.freeze(["abortAll","assertCurrent","effectiveKeys","inject","loadApiSettings","loadKnowledge","migrateWorkspace","normalizeBatchRanges","publicState","queueAutomaticSummary","recallChanged","refresh","reportError","setMessage","syncAutoStartFloor","syncModulesQuietly","wakeVectors"]),
    reads: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","apiOperations","apiSettings","autoFailureCount","autoFailureRange","automaticPaused","bindings","boundRefKey","boundScope","cancelVersion","chatListeners","core","disposed","dynamicPersona","enabled","epoch","feedbackSequence","followNotBefore","followPending","followReadAttempts","followTimer","followVersion","followWaiters","following","foreground","foregroundBusy","generationListeners","host","hostAdapter","injectedPayloads","injecting","injectionLog","knowledgeCache","moduleSourceBaseline","moduleSourceChatId","moduleStamp","modules","notify","opening","operations","personaCommandVersion","personaPromptModule","personaWorldbook","preparedQuality","providerScheduler","qualitySaved","retrospectiveOperation","retrospectiveSaved","runtimeLog","sourceContextComplete","sourcePrefixVerified","state","stopForceTimer","tracking","trackingStart","vectorExcluded","vectorJob","vectorStopped","vectorTimer","workspace"]),
    writes: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","autoFailureCount","autoFailureRange","automaticPaused","boundRefKey","boundScope","enabled","epoch","feedbackSequence","followNotBefore","followPending","followReadAttempts","followTimer","followVersion","following","foreground","hostAdapter","injecting","injectionLog","knowledgeCache","moduleSourceBaseline","moduleSourceChatId","opening","personaCommandVersion","personaPromptModule","preparedQuality","qualitySaved","retrospectiveSaved","sourceContextComplete","sourcePrefixVerified","stopForceTimer","tracking","trackingStart","vectorExcluded","vectorStopped","vectorTimer","workspace"])
  }),
  operations: Object.freeze({
    provides: Object.freeze(["assertCurrent","continuationCheck","begin","abortAll","beginApi","currentMemoryMutation","beginMemoryMutation","trackedMemoryMutation"]),
    requires: Object.freeze(["recallChanged","wakeAutomaticSummary","wakeChatFollower","wakeVectors"]),
    reads: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","apiOperations","autoHistoryAttempts","autoHistoryMessageId","autoHistorySource","autoPending","autoRetryAt","autoRunOwner","autoRunning","autoTask","autoTaskOwner","autoTimer","cancelVersion","disposed","epoch","memoryMutationGuards","memoryMutationKey","notify","operations","qualityOperation","workspace"]),
    writes: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","autoHistoryAttempts","autoHistoryMessageId","autoHistorySource","autoPending","autoRetryAt","autoRunOwner","autoRunning","autoTask","autoTaskOwner","autoTimer","cancelVersion"])
  }),
  diagnostics: Object.freeze({
    provides: Object.freeze(["trackDiagnostic","reportError","flushDiagnostics","logged"]),
    requires: Object.freeze([]),
    reads: Object.freeze(["cancelVersion","diagnosticJobs","recordedErrors","runtimeLog","state"]),
    writes: Object.freeze([])
  }),
  view: Object.freeze({
    provides: Object.freeze(["activeDictionary","summaryMonitor","publicState","readViewState","setMessage","summaryFeedback"]),
    requires: Object.freeze(["apiConnectionReady","automaticPlan","currentMemoryMutation","effectiveKeys","validAutomaticBatches"]),
    reads: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","apiOperations","autoFailureCount","autoHistoryAttempts","autoInvalidSources","autoPending","autoRetryAt","autoRunOwner","autoRunning","autoTaskOwner","automaticPaused","core","dictionaryCache","dictionaryProfiles","dictionaryRevision","disposed","enabled","feedbackSequence","followPending","following","host","injectionLog","keyEdited","keys","knowledgeCache","notify","opening","personaLaunch","qualityOperation","queuedRequests","recallRevision","runtimeLog","state","vectorJob","viewIdentity","viewPlanCache","workspace"]),
    writes: Object.freeze(["dictionaryCache","dictionaryProfiles","dictionaryRevision","feedbackSequence","viewPlanCache"])
  }),
  settings: Object.freeze({
    provides: Object.freeze(["effectiveKeys","loadApiSettings","client","apiConnectionReady","resolvedPersonaSettings","saveUi","saveSettings","saveApi","forgetKey","listModels","testConnection"]),
    requires: Object.freeze(["beginApi","clearPrompt","loadKnowledge","queueAutomaticSummary","recallChanged","reportError","setMessage"]),
    reads: Object.freeze(["apiSettings","core","credentials","credentialsLoaded","dynamicPersona","feedbackSequence","fetchImpl","globalLoaded","globalLoading","globalStore","globalWorkspace","keyEdited","keyOrigins","keyVersions","keys","modules","notify","prefixFor","state"]),
    writes: Object.freeze(["credentialsLoaded","feedbackSequence","globalLoaded","globalLoading","globalWorkspace"])
  }),
  memory: Object.freeze({
    provides: Object.freeze(["migrateWorkspace","refresh","syncModulesQuietly","normalizeBatchRanges","readBatches","deleteRecord","deletePerson","deleteRecords","restoreRecord","editRecord","editPersonProfile","saveCharacterKeepsake","hideRecord","restoreHidden"]),
    requires: Object.freeze(["activeDictionary","assertCurrent","begin","captureRecallSnapshot","followCurrentChat","recallChanged","rememberModuleSources","reportError","reservePersonaCommand","setMessage","sourceEventRelevant","warmRecall"]),
    reads: Object.freeze(["active","activeSummaryBatchId","autoInvalidSources","cancelVersion","committedRecall","core","disposed","dynamicPersona","epoch","globalWorkspace","host","keepsakeSourceCard","memoryMutationGuards","memoryMutationKey","mergeDecisions","modules","notify","pendingMemoryMutation","personDeleteFailure","personaLaunch","qualitySaved","recallBusy","retrospectiveOperation","retrospectiveSaved","runtimeLog","sourcePrefixVerified","state","tracking","workspace"]),
    writes: Object.freeze(["autoInvalidSources","committedRecall","mergeDecisions","qualitySaved","recallBusy","retrospectiveSaved","sourcePrefixVerified"])
  }),
  summary: Object.freeze({
    provides: Object.freeze(["prepareSummaryChat","previewSummary","summarize","regenerateBatch","retryBatch","retryIncompleteBatches","splitSummaryBatch","previewApplySummaryPrefix","applySummaryPrefix","manageBatches","deleteBatch","restoreBatch"]),
    requires: Object.freeze(["assertCurrent","begin","beginMemoryMutation","continuationCheck","logged","open","processMergeQueue","queueAutomaticQuality","readBatches","refresh","reportError","setMessage","summaryFeedback","summaryMonitor","syncAutoStartFloor","trackedMemoryMutation","validAutomaticBatches"]),
    reads: Object.freeze(["active","activeSummaryBatchId","activeSummaryOperation","autoRunOwner","boundRefKey","cancelVersion","core","enabled","epoch","feedbackSequence","following","host","hostAdapter","notify","opening","overwriteHash","qualitySaved","replacementEditsHash","runtimeLog","state","summaryRecipeHash","workspace"]),
    writes: Object.freeze(["activeSummaryBatchId","activeSummaryOperation","feedbackSequence","hostAdapter","workspace"])
  }),
  automatic: Object.freeze({
    provides: Object.freeze(["validAutomaticBatches","automaticPlan","syncAutoStartFloor","inspectAutomaticProgress","setAutoStartFloor","setAutomatic","queueAutomaticSummary","wakeAutomaticSummary","autoSummary"]),
    requires: Object.freeze(["apiConnectionReady","assertCurrent","begin","currentMemoryMutation","open","prepareSummaryChat","refresh","reportError","retryBatch","saveSettings","setMessage","settledHistoryTail","summarize","summaryFeedback","syncModulesQuietly"]),
    reads: Object.freeze(["active","autoFailureCount","autoFailureRange","autoHistoryAttempts","autoHistoryMessageId","autoHistorySource","autoInvalidSources","autoPending","autoRetryAt","autoRunOwner","autoRunning","autoTask","autoTaskOwner","autoTimer","automaticPaused","bindings","boundRefKey","cancelVersion","core","disposed","enabled","epoch","feedbackSequence","followPending","following","host","notify","opening","runtimeLog","state","workspace"]),
    writes: Object.freeze(["autoFailureCount","autoFailureRange","autoHistoryAttempts","autoHistoryMessageId","autoHistorySource","autoPending","autoRetryAt","autoRunOwner","autoRunning","autoTask","autoTaskOwner","autoTimer","automaticPaused"])
  }),
  recall: Object.freeze({
    provides: Object.freeze(["captureRecallSnapshot","recallChanged","readNarrativeSource","warmRecall","externalState","preview","inject"]),
    requires: Object.freeze(["activeDictionary","apiConnectionReady","assertCurrent","begin","client","combinedVectorEntries","currentMemoryMutation","knowledgeCards","refreshVectorStatus","reportError","setMessage","syncModulesQuietly"]),
    reads: Object.freeze(["boundScope","committedRecall","core","disposed","enabled","epoch","host","injectedPayloads","injectionLog","knowledgeCache","knowledgeVectorCache","notify","pendingMemoryMutation","recallBusy","recallCache","recallReaders","recallRevision","recallSafetyRevision","rerankBudgetMs","rerankLane","runtimeLog","state","vectorBudgetMs","vectorCache","vectorCheckVersion","vectorExcluded","vectorJob","vectorLane","vectorTimer","workspace"]),
    writes: Object.freeze(["committedRecall","recallReaders","recallRevision","recallSafetyRevision","vectorCheckVersion","vectorTimer"])
  }),
  vectors: Object.freeze({
    provides: Object.freeze(["combinedVectorEntries","excludeVector","listVectorEntries","wakeVectors","refreshVectorStatus","buildVectors","retryBatchVectors"]),
    requires: Object.freeze(["assertCurrent","begin","client","logged","prepareSummaryChat","recallChanged","refresh","reportError","setMessage"]),
    reads: Object.freeze(["active","core","disposed","enabled","epoch","foregroundBusy","globalWorkspace","host","knowledgeCache","knowledgeVectorCache","notify","recallBusy","recallReaders","recallRevision","runtimeLog","state","vectorCache","vectorCheckVersion","vectorExcluded","vectorJob","vectorStopped","vectorStorageFailure","vectorTimer","workspace"]),
    writes: Object.freeze(["vectorCheckVersion","vectorExcluded","vectorJob","vectorStopped","vectorStorageFailure","vectorTimer"])
  }),
  reviews: Object.freeze({
    provides: Object.freeze(["queueAutomaticQuality","reviewMemoryConsistency","undoMemoryConsistency","processMergeQueue","previewQuality","inspectQualityRecord","saveQualityRecord","reviewMemory","undoQuality","retryMerges","keepMergeSeparate","chooseMergeTarget"]),
    requires: Object.freeze(["activeDictionary","assertCurrent","begin","captureRecallSnapshot","client","logged","prepareSummaryChat","recallChanged","refresh","refreshVectorStatus","reportError","setMessage"]),
    reads: Object.freeze(["active","automaticQualityQueue","committedRecall","core","disposed","dynamicPersona","epoch","feedbackSequence","foregroundBusy","mergeDecisions","modules","notify","personaLaunch","preparedQuality","qualityJob","qualityOperation","qualitySaved","retrospectiveOperation","retrospectiveSaved","runtimeLog","state","workspace"]),
    writes: Object.freeze(["automaticQualityQueue","committedRecall","feedbackSequence","preparedQuality","qualityJob","qualityOperation","qualitySaved","retrospectiveOperation","retrospectiveSaved"])
  }),
  documents: Object.freeze({
    provides: Object.freeze(["loadKnowledge","knowledgeCards","addDocument","removeDocument","analyzeDocuments","updateDocument","documentPreview","editDocumentChunk","buildKnowledgeVectors"]),
    requires: Object.freeze(["beginApi","captureRecallSnapshot","client","loadApiSettings","recallChanged","replyLimit","setMessage"]),
    reads: Object.freeze(["committedRecall","core","globalWorkspace","knowledgeCache","knowledgeJob","knowledgeVectorCache","notify","recallBusy","runtimeLog","state","workspace"]),
    writes: Object.freeze(["committedRecall","knowledgeCache","knowledgeJob","recallBusy"])
  }),
  assistant: Object.freeze({
    provides: Object.freeze(["replyLimit","assistant","applyProposal","undoSettings","newConversation","selectConversation","deleteConversation"]),
    requires: Object.freeze(["activeDictionary","beginApi","client","loadApiSettings","reportError","saveSettings","saveUi","setMessage"]),
    reads: Object.freeze(["assistantActive","core","globalWorkspace","injectionLog","modules","notify","state","workspace"]),
    writes: Object.freeze(["assistantActive"])
  }),
  persona: Object.freeze({
    provides: Object.freeze(["assertNoRetrospective","reservePersonaCommand","queueDynamicPersona","retryDynamicPersonaManualBatch","manageDynamicPersonaCandidate"]),
    requires: Object.freeze(["assertCurrent","logged","saveSettings"]),
    reads: Object.freeze(["core","dynamicPersona","enabled","epoch","notify","personaCommandVersion","personaLaunch","retrospectiveOperation"]),
    writes: Object.freeze(["personaLaunch"])
  }),
  api: Object.freeze({
    provides: Object.freeze([]),
    requires: Object.freeze(["addDocument","analyzeDocuments","applyProposal","applySummaryPrefix","assertCurrent","assertNoRetrospective","assistant","autoSummary","buildKnowledgeVectors","buildVectors","chooseMergeTarget","deleteBatch","deleteConversation","deletePerson","deleteRecord","deleteRecords","disable","documentPreview","editDocumentChunk","editPersonProfile","editRecord","effectiveKeys","excludeVector","flushDiagnostics","followCurrentChat","forgetKey","hideRecord","inspectAutomaticProgress","inspectQualityRecord","keepMergeSeparate","listModels","listVectorEntries","loadApiSettings","logged","manageBatches","manageDynamicPersonaCandidate","newConversation","open","preview","previewApplySummaryPrefix","previewQuality","previewSummary","publicState","queueDynamicPersona","readNarrativeSource","readViewState","recallChanged","refresh","refreshVectorStatus","regenerateBatch","removeDocument","reportError","reservePersonaCommand","restoreBatch","restoreHidden","restoreRecord","retryBatch","retryBatchVectors","retryDynamicPersonaManualBatch","retryIncompleteBatches","retryMerges","reviewMemory","reviewMemoryConsistency","saveApi","saveCharacterKeepsake","saveQualityRecord","saveSettings","saveUi","selectConversation","setAutoStartFloor","setAutomatic","setMessage","splitSummaryBatch","startChatTracking","stop","summarize","testConnection","undoMemoryConsistency","undoQuality","undoSettings","updateDocument"]),
    reads: Object.freeze(["active","bindings","boundScope","chatListeners","core","diagnosticJobs","disposed","dynamicPersona","enabled","epoch","exportRawBackup","followPending","followTimer","followWaiters","generationListeners","globalWorkspace","host","hostAdapter","injectionLog","keyEdited","keyOrigins","keyVersions","keys","mergeDecisions","modules","personaCommandVersion","prefixFor","qualitySaved","resumeAutomaticTasks","resumeVectorMaintenance","retrospectiveOperation","retrospectiveSaved","runtimeLog","state","stopErrorBoundary","stopForceTimer","stopRequestScheduler","stopTransportDiagnostics","tracking","workspace"]),
    writes: Object.freeze(["disposed","epoch","followPending","followTimer","personaCommandVersion","stopForceTimer","tracking"])
  })
});
