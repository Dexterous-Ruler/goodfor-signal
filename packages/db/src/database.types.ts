export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_health: {
        Row: {
          fyf_traffic_share: number | null
          id: number
          originality_status: string | null
          owned_account_id: number
          search_traffic_share: number | null
          strike_count_by_area: Json
          suppression_flag: boolean
          ts: string
        }
        Insert: {
          fyf_traffic_share?: number | null
          id?: never
          originality_status?: string | null
          owned_account_id: number
          search_traffic_share?: number | null
          strike_count_by_area?: Json
          suppression_flag?: boolean
          ts?: string
        }
        Update: {
          fyf_traffic_share?: number | null
          id?: never
          originality_status?: string | null
          owned_account_id?: number
          search_traffic_share?: number | null
          strike_count_by_area?: Json
          suppression_flag?: boolean
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_health_owned_account_id_fkey"
            columns: ["owned_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
        ]
      }
      analysis_queue: {
        Row: {
          attempts: number
          completed_at: string | null
          enqueued_at: string
          last_error: string | null
          priority: number
          reason: string | null
          started_at: string | null
          video_id: number
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          enqueued_at?: string
          last_error?: string | null
          priority?: number
          reason?: string | null
          started_at?: string | null
          video_id: number
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          enqueued_at?: string
          last_error?: string | null
          priority?: number
          reason?: string | null
          started_at?: string | null
          video_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "analysis_queue_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: true
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      app: {
        Row: {
          id: number
          name: string
          slug: string
        }
        Insert: {
          id?: never
          name: string
          slug: string
        }
        Update: {
          id?: never
          name?: string
          slug?: string
        }
        Relationships: []
      }
      app_conversion: {
        Row: {
          captured_at: string
          event_type: string
          id: number
          install_id: number | null
          occurred_at: string
          revenue_cents: number | null
        }
        Insert: {
          captured_at?: string
          event_type: string
          id?: never
          install_id?: number | null
          occurred_at: string
          revenue_cents?: number | null
        }
        Update: {
          captured_at?: string
          event_type?: string
          id?: never
          install_id?: number | null
          occurred_at?: string
          revenue_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "app_conversion_install_id_fkey"
            columns: ["install_id"]
            isOneToOne: false
            referencedRelation: "attributed_install"
            referencedColumns: ["id"]
          },
        ]
      }
      apple_analytics_daily: {
        Row: {
          loaded_at: string
          metric_name: string
          processing_date: string
          report_date: string
          source_type: string
          value: number
        }
        Insert: {
          loaded_at?: string
          metric_name: string
          processing_date: string
          report_date: string
          source_type: string
          value: number
        }
        Update: {
          loaded_at?: string
          metric_name?: string
          processing_date?: string
          report_date?: string
          source_type?: string
          value?: number
        }
        Relationships: []
      }
      attributed_install: {
        Row: {
          device_pseudo_id: string | null
          featured_post_id: number | null
          first_launch_at: string | null
          format_cluster_id: number | null
          id: number
          installed_at: string
          is_deterministic: boolean
          owned_account_id: number | null
          platform: string
          source: string
          utm_content: string | null
        }
        Insert: {
          device_pseudo_id?: string | null
          featured_post_id?: number | null
          first_launch_at?: string | null
          format_cluster_id?: number | null
          id?: never
          installed_at: string
          is_deterministic: boolean
          owned_account_id?: number | null
          platform: string
          source: string
          utm_content?: string | null
        }
        Update: {
          device_pseudo_id?: string | null
          featured_post_id?: number | null
          first_launch_at?: string | null
          format_cluster_id?: number | null
          id?: never
          installed_at?: string
          is_deterministic?: boolean
          owned_account_id?: number | null
          platform?: string
          source?: string
          utm_content?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attributed_install_featured_post_id_fkey"
            columns: ["featured_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_post"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attributed_install_format_cluster_id_fkey"
            columns: ["format_cluster_id"]
            isOneToOne: false
            referencedRelation: "format_cluster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attributed_install_owned_account_id_fkey"
            columns: ["owned_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
        ]
      }
      bio_link: {
        Row: {
          created_at: string
          id: number
          owned_account_id: number
          slug: string
          store_url_android: string
          store_url_ios: string
        }
        Insert: {
          created_at?: string
          id?: never
          owned_account_id: number
          slug: string
          store_url_android: string
          store_url_ios: string
        }
        Update: {
          created_at?: string
          id?: never
          owned_account_id?: number
          slug?: string
          store_url_android?: string
          store_url_ios?: string
        }
        Relationships: [
          {
            foreignKeyName: "bio_link_owned_account_id_fkey"
            columns: ["owned_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
        ]
      }
      bio_link_rotation: {
        Row: {
          bio_link_id: number
          featured_post_id: number | null
          format_cluster_id: number | null
          id: number
          rotated_off_at: string | null
          rotated_on_at: string
          utm_content: string
        }
        Insert: {
          bio_link_id: number
          featured_post_id?: number | null
          format_cluster_id?: number | null
          id?: never
          rotated_off_at?: string | null
          rotated_on_at?: string
          utm_content: string
        }
        Update: {
          bio_link_id?: number
          featured_post_id?: number | null
          format_cluster_id?: number | null
          id?: never
          rotated_off_at?: string | null
          rotated_on_at?: string
          utm_content?: string
        }
        Relationships: [
          {
            foreignKeyName: "bio_link_rotation_bio_link_id_fkey"
            columns: ["bio_link_id"]
            isOneToOne: false
            referencedRelation: "bio_link"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bio_link_rotation_featured_post_id_fkey"
            columns: ["featured_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_post"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bio_link_rotation_format_cluster_id_fkey"
            columns: ["format_cluster_id"]
            isOneToOne: false
            referencedRelation: "format_cluster"
            referencedColumns: ["id"]
          },
        ]
      }
      brief: {
        Row: {
          app_slug: string
          competitor_claims: Json
          competitor_inspiration_id: number | null
          created_at: string
          format_cluster_id: number | null
          hook_type: string | null
          id: number
          sound_id: string | null
          sound_is_cml: boolean | null
          status: string
          target_account_type: string
        }
        Insert: {
          app_slug: string
          competitor_claims?: Json
          competitor_inspiration_id?: number | null
          created_at?: string
          format_cluster_id?: number | null
          hook_type?: string | null
          id?: never
          sound_id?: string | null
          sound_is_cml?: boolean | null
          status?: string
          target_account_type: string
        }
        Update: {
          app_slug?: string
          competitor_claims?: Json
          competitor_inspiration_id?: number | null
          created_at?: string
          format_cluster_id?: number | null
          hook_type?: string | null
          id?: never
          sound_id?: string | null
          sound_is_cml?: boolean | null
          status?: string
          target_account_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "brief_competitor_inspiration_id_fkey"
            columns: ["competitor_inspiration_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign: {
        Row: {
          app_id: number
          brief_url: string | null
          budget_cents: number | null
          end_date: string | null
          id: number
          objective: string | null
          start_date: string | null
        }
        Insert: {
          app_id: number
          brief_url?: string | null
          budget_cents?: number | null
          end_date?: string | null
          id?: never
          objective?: string | null
          start_date?: string | null
        }
        Update: {
          app_id?: number
          brief_url?: string | null
          budget_cents?: number | null
          end_date?: string | null
          id?: never
          objective?: string | null
          start_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
        ]
      }
      collaboration: {
        Row: {
          campaign_id: number
          contracted_at: string | null
          created_at: string
          creator_account_id: number
          currency: string | null
          first_contacted_at: string | null
          id: number
          next_action_at: string | null
          owner_user_id: number | null
          rate_cents: number | null
          replied_at: string | null
          source: string | null
          stage: string
        }
        Insert: {
          campaign_id: number
          contracted_at?: string | null
          created_at?: string
          creator_account_id: number
          currency?: string | null
          first_contacted_at?: string | null
          id?: never
          next_action_at?: string | null
          owner_user_id?: number | null
          rate_cents?: number | null
          replied_at?: string | null
          source?: string | null
          stage?: string
        }
        Update: {
          campaign_id?: number
          contracted_at?: string | null
          created_at?: string
          creator_account_id?: number
          currency?: string | null
          first_contacted_at?: string | null
          id?: never
          next_action_at?: string | null
          owner_user_id?: number | null
          rate_cents?: number | null
          replied_at?: string | null
          source?: string | null
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "collaboration_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collaboration_creator_account_id_fkey"
            columns: ["creator_account_id"]
            isOneToOne: false
            referencedRelation: "creator_account"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_account: {
        Row: {
          added_at: string
          display_name: string | null
          follower_count: number | null
          id: number
          is_tracked: boolean
          notes: string | null
          platform_user_id: string
          sec_uid: string | null
          tracking_tier: number
          username: string
          vendor_last_synced_at: string | null
        }
        Insert: {
          added_at?: string
          display_name?: string | null
          follower_count?: number | null
          id?: never
          is_tracked?: boolean
          notes?: string | null
          platform_user_id: string
          sec_uid?: string | null
          tracking_tier?: number
          username: string
          vendor_last_synced_at?: string | null
        }
        Update: {
          added_at?: string
          display_name?: string | null
          follower_count?: number | null
          id?: never
          is_tracked?: boolean
          notes?: string | null
          platform_user_id?: string
          sec_uid?: string | null
          tracking_tier?: number
          username?: string
          vendor_last_synced_at?: string | null
        }
        Relationships: []
      }
      creator_account: {
        Row: {
          avg_views: number | null
          creator_identity_id: number | null
          engagement_rate: number | null
          followers: number | null
          id: number
          is_verified: boolean | null
          last_posted_at: string | null
          platform: string
          platform_user_id: string
          source_vendor: string
          url: string | null
          username: string | null
          vendor_last_synced_at: string
        }
        Insert: {
          avg_views?: number | null
          creator_identity_id?: number | null
          engagement_rate?: number | null
          followers?: number | null
          id?: never
          is_verified?: boolean | null
          last_posted_at?: string | null
          platform: string
          platform_user_id: string
          source_vendor: string
          url?: string | null
          username?: string | null
          vendor_last_synced_at: string
        }
        Update: {
          avg_views?: number | null
          creator_identity_id?: number | null
          engagement_rate?: number | null
          followers?: number | null
          id?: never
          is_verified?: boolean | null
          last_posted_at?: string | null
          platform?: string
          platform_user_id?: string
          source_vendor?: string
          url?: string | null
          username?: string | null
          vendor_last_synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "creator_account_creator_identity_id_fkey"
            columns: ["creator_identity_id"]
            isOneToOne: false
            referencedRelation: "creator_identity"
            referencedColumns: ["id"]
          },
        ]
      }
      creator_audience: {
        Row: {
          age_split: Json | null
          audience_quality_score: number | null
          audience_reachability: number | null
          captured_at: string
          creator_account_id: number
          credibility_score: number | null
          gender_split: Json | null
          geo_countries: Json | null
          id: number
          interests: Json | null
          languages: Json | null
        }
        Insert: {
          age_split?: Json | null
          audience_quality_score?: number | null
          audience_reachability?: number | null
          captured_at: string
          creator_account_id: number
          credibility_score?: number | null
          gender_split?: Json | null
          geo_countries?: Json | null
          id?: never
          interests?: Json | null
          languages?: Json | null
        }
        Update: {
          age_split?: Json | null
          audience_quality_score?: number | null
          audience_reachability?: number | null
          captured_at?: string
          creator_account_id?: number
          credibility_score?: number | null
          gender_split?: Json | null
          geo_countries?: Json | null
          id?: never
          interests?: Json | null
          languages?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "creator_audience_creator_account_id_fkey"
            columns: ["creator_account_id"]
            isOneToOne: false
            referencedRelation: "creator_account"
            referencedColumns: ["id"]
          },
        ]
      }
      creator_identity: {
        Row: {
          country: string | null
          created_at: string
          display_name: string | null
          id: number
          notes: string | null
          payment_entity_id: number | null
          primary_email: string | null
          timezone: string | null
        }
        Insert: {
          country?: string | null
          created_at?: string
          display_name?: string | null
          id?: never
          notes?: string | null
          payment_entity_id?: number | null
          primary_email?: string | null
          timezone?: string | null
        }
        Update: {
          country?: string | null
          created_at?: string
          display_name?: string | null
          id?: never
          notes?: string | null
          payment_entity_id?: number | null
          primary_email?: string | null
          timezone?: string | null
        }
        Relationships: []
      }
      creator_metric_snapshot: {
        Row: {
          avg_views: number | null
          captured_at: string
          creator_account_id: number
          engagement_rate: number | null
          followers: number | null
        }
        Insert: {
          avg_views?: number | null
          captured_at: string
          creator_account_id: number
          engagement_rate?: number | null
          followers?: number | null
        }
        Update: {
          avg_views?: number | null
          captured_at?: string
          creator_account_id?: number
          engagement_rate?: number | null
          followers?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "creator_metric_snapshot_creator_account_id_fkey"
            columns: ["creator_account_id"]
            isOneToOne: false
            referencedRelation: "creator_account"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_product_page: {
        Row: {
          cpp_apple_id: string
          created_at: string
          ct_code: string
          format_cluster_id: number | null
          id: number
          name: string
        }
        Insert: {
          cpp_apple_id: string
          created_at?: string
          ct_code: string
          format_cluster_id?: number | null
          id?: never
          name: string
        }
        Update: {
          cpp_apple_id?: string
          created_at?: string
          ct_code?: string
          format_cluster_id?: number | null
          id?: never
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_product_page_format_cluster_id_fkey"
            columns: ["format_cluster_id"]
            isOneToOne: false
            referencedRelation: "format_cluster"
            referencedColumns: ["id"]
          },
        ]
      }
      deliverable: {
        Row: {
          asset_url: string | null
          collaboration_id: number
          due_date: string | null
          id: number
          is_spark_ads_authorized: boolean
          platform_post_id: string | null
          posted_url: string | null
          spark_ads_code: string | null
          spark_ads_expires_at: string | null
          status: string | null
          type: string | null
        }
        Insert: {
          asset_url?: string | null
          collaboration_id: number
          due_date?: string | null
          id?: never
          is_spark_ads_authorized?: boolean
          platform_post_id?: string | null
          posted_url?: string | null
          spark_ads_code?: string | null
          spark_ads_expires_at?: string | null
          status?: string | null
          type?: string | null
        }
        Update: {
          asset_url?: string | null
          collaboration_id?: number
          due_date?: string | null
          id?: never
          is_spark_ads_authorized?: boolean
          platform_post_id?: string | null
          posted_url?: string | null
          spark_ads_code?: string | null
          spark_ads_expires_at?: string | null
          status?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliverable_collaboration_id_fkey"
            columns: ["collaboration_id"]
            isOneToOne: false
            referencedRelation: "collaboration"
            referencedColumns: ["id"]
          },
        ]
      }
      format_cluster: {
        Row: {
          definition: string | null
          distinguishing_features: string[] | null
          id: number
          label: string
          median_views: number | null
          median_z: number | null
          member_count: number
          updated_at: string
        }
        Insert: {
          definition?: string | null
          distinguishing_features?: string[] | null
          id: number
          label: string
          median_views?: number | null
          median_z?: number | null
          member_count?: number
          updated_at?: string
        }
        Update: {
          definition?: string | null
          distinguishing_features?: string[] | null
          id?: number
          label?: string
          median_views?: number | null
          median_z?: number | null
          member_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      format_lift: {
        Row: {
          fit_date: string
          format_cluster_id: number
          k_format: number
          lag_days: number
          r_squared: number | null
        }
        Insert: {
          fit_date: string
          format_cluster_id: number
          k_format: number
          lag_days?: number
          r_squared?: number | null
        }
        Update: {
          fit_date?: string
          format_cluster_id?: number
          k_format?: number
          lag_days?: number
          r_squared?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "format_lift_format_cluster_id_fkey"
            columns: ["format_cluster_id"]
            isOneToOne: false
            referencedRelation: "format_cluster"
            referencedColumns: ["id"]
          },
        ]
      }
      hdyhau_response: {
        Row: {
          followup_account_id: number | null
          followup_post_id: number | null
          id: number
          placement: string
          selected_channel: string | null
          submitted_at: string
          user_pseudo_id: string
        }
        Insert: {
          followup_account_id?: number | null
          followup_post_id?: number | null
          id?: never
          placement: string
          selected_channel?: string | null
          submitted_at?: string
          user_pseudo_id: string
        }
        Update: {
          followup_account_id?: number | null
          followup_post_id?: number | null
          id?: never
          placement?: string
          selected_channel?: string | null
          submitted_at?: string
          user_pseudo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hdyhau_response_followup_account_id_fkey"
            columns: ["followup_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hdyhau_response_followup_post_id_fkey"
            columns: ["followup_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_post"
            referencedColumns: ["id"]
          },
        ]
      }
      incrementality_test: {
        Row: {
          account_scope: string | null
          baseline_installs: number | null
          channel: string
          computed_cpi_cents: number | null
          ended_at: string | null
          fully_loaded_cost_cents: number | null
          id: number
          incremental_installs: number | null
          method: string
          notes: string | null
          observed_installs: number | null
          started_at: string
        }
        Insert: {
          account_scope?: string | null
          baseline_installs?: number | null
          channel: string
          computed_cpi_cents?: number | null
          ended_at?: string | null
          fully_loaded_cost_cents?: number | null
          id?: never
          incremental_installs?: number | null
          method: string
          notes?: string | null
          observed_installs?: number | null
          started_at: string
        }
        Update: {
          account_scope?: string | null
          baseline_installs?: number | null
          channel?: string
          computed_cpi_cents?: number | null
          ended_at?: string | null
          fully_loaded_cost_cents?: number | null
          id?: never
          incremental_installs?: number | null
          method?: string
          notes?: string | null
          observed_installs?: number | null
          started_at?: string
        }
        Relationships: []
      }
      keyword_trend: {
        Row: {
          acceleration: number | null
          burst_weight: number | null
          id: number
          post_count: number | null
          state: string | null
          term: string
          term_type: string
          tracked_term_id: number | null
          ts: string
          velocity: number | null
          view_count: number | null
        }
        Insert: {
          acceleration?: number | null
          burst_weight?: number | null
          id?: never
          post_count?: number | null
          state?: string | null
          term: string
          term_type: string
          tracked_term_id?: number | null
          ts: string
          velocity?: number | null
          view_count?: number | null
        }
        Update: {
          acceleration?: number | null
          burst_weight?: number | null
          id?: never
          post_count?: number | null
          state?: string | null
          term?: string
          term_type?: string
          tracked_term_id?: number | null
          ts?: string
          velocity?: number | null
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "keyword_trend_tracked_term_id_fkey"
            columns: ["tracked_term_id"]
            isOneToOne: false
            referencedRelation: "tracked_term"
            referencedColumns: ["id"]
          },
        ]
      }
      library_item: {
        Row: {
          brief_id: number | null
          collection: string
          created_at: string
          creator_id: number | null
          id: number
          kind: string
          meta: string | null
          notes: string | null
          tags: string[]
          term: string | null
          title: string
          video_id: number | null
        }
        Insert: {
          brief_id?: number | null
          collection?: string
          created_at?: string
          creator_id?: number | null
          id?: number
          kind: string
          meta?: string | null
          notes?: string | null
          tags?: string[]
          term?: string | null
          title: string
          video_id?: number | null
        }
        Update: {
          brief_id?: number | null
          collection?: string
          created_at?: string
          creator_id?: number | null
          id?: number
          kind?: string
          meta?: string | null
          notes?: string | null
          tags?: string[]
          term?: string | null
          title?: string
          video_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "library_item_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "brief"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "library_item_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "creator_account"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "library_item_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      owned_account: {
        Row: {
          access_expires_at: string | null
          access_token: string | null
          account_type: string
          app_slug: string
          created_at: string
          id: number
          original_granted_at: string | null
          posts_last_24h: number
          prev_access_token: string | null
          prev_refresh_token: string | null
          quarantine_reason: string | null
          quarantined_until: string | null
          refresh_expires_at: string | null
          refresh_token: string | null
          tiktok_open_id: string
          token_generation: number
          uploads_in_flight: number
          username: string
        }
        Insert: {
          access_expires_at?: string | null
          access_token?: string | null
          account_type: string
          app_slug: string
          created_at?: string
          id?: never
          original_granted_at?: string | null
          posts_last_24h?: number
          prev_access_token?: string | null
          prev_refresh_token?: string | null
          quarantine_reason?: string | null
          quarantined_until?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          tiktok_open_id: string
          token_generation?: number
          uploads_in_flight?: number
          username: string
        }
        Update: {
          access_expires_at?: string | null
          access_token?: string | null
          account_type?: string
          app_slug?: string
          created_at?: string
          id?: never
          original_granted_at?: string | null
          posts_last_24h?: number
          prev_access_token?: string | null
          prev_refresh_token?: string | null
          quarantine_reason?: string | null
          quarantined_until?: string | null
          refresh_expires_at?: string | null
          refresh_token?: string | null
          tiktok_open_id?: string
          token_generation?: number
          uploads_in_flight?: number
          username?: string
        }
        Relationships: []
      }
      payment: {
        Row: {
          amount_cents: number
          collaboration_id: number
          currency: string
          id: number
          invoice_url: string | null
          method: string | null
          platform_fee_cents: number | null
          status: string | null
          tax_form_status: string | null
        }
        Insert: {
          amount_cents: number
          collaboration_id: number
          currency?: string
          id?: never
          invoice_url?: string | null
          method?: string | null
          platform_fee_cents?: number | null
          status?: string | null
          tax_form_status?: string | null
        }
        Update: {
          amount_cents?: number
          collaboration_id?: number
          currency?: string
          id?: never
          invoice_url?: string | null
          method?: string | null
          platform_fee_cents?: number | null
          status?: string | null
          tax_form_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_collaboration_id_fkey"
            columns: ["collaboration_id"]
            isOneToOne: false
            referencedRelation: "collaboration"
            referencedColumns: ["id"]
          },
        ]
      }
      performance_fact: {
        Row: {
          captured_at: string
          comments: number | null
          deliverable_id: number
          id: number
          install_count: number | null
          likes: number | null
          revenue_cents: number | null
          saves: number | null
          shares: number | null
          signup_count: number | null
          subscription_count: number | null
          trial_count: number | null
          views: number | null
        }
        Insert: {
          captured_at: string
          comments?: number | null
          deliverable_id: number
          id?: never
          install_count?: number | null
          likes?: number | null
          revenue_cents?: number | null
          saves?: number | null
          shares?: number | null
          signup_count?: number | null
          subscription_count?: number | null
          trial_count?: number | null
          views?: number | null
        }
        Update: {
          captured_at?: string
          comments?: number | null
          deliverable_id?: number
          id?: never
          install_count?: number | null
          likes?: number | null
          revenue_cents?: number | null
          saves?: number | null
          shares?: number | null
          signup_count?: number | null
          subscription_count?: number | null
          trial_count?: number | null
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "performance_fact_deliverable_id_fkey"
            columns: ["deliverable_id"]
            isOneToOne: false
            referencedRelation: "deliverable"
            referencedColumns: ["id"]
          },
        ]
      }
      publish_attempt: {
        Row: {
          error_code: string | null
          http_status: number | null
          id: number
          owned_account_id: number
          raw_response: Json | null
          scheduled_post_id: number
          step: string
          ts: string
        }
        Insert: {
          error_code?: string | null
          http_status?: number | null
          id?: never
          owned_account_id: number
          raw_response?: Json | null
          scheduled_post_id: number
          step: string
          ts?: string
        }
        Update: {
          error_code?: string | null
          http_status?: number | null
          id?: never
          owned_account_id?: number
          raw_response?: Json | null
          scheduled_post_id?: number
          step?: string
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "publish_attempt_owned_account_id_fkey"
            columns: ["owned_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publish_attempt_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_post"
            referencedColumns: ["id"]
          },
        ]
      }
      rights_grant: {
        Row: {
          collaboration_id: number
          exclusivity_window_days: number | null
          expires_at: string | null
          id: number
          renewal_price_cents: number | null
          starts_at: string
          territories: string[] | null
          usage_scope: string
        }
        Insert: {
          collaboration_id: number
          exclusivity_window_days?: number | null
          expires_at?: string | null
          id?: never
          renewal_price_cents?: number | null
          starts_at: string
          territories?: string[] | null
          usage_scope: string
        }
        Update: {
          collaboration_id?: number
          exclusivity_window_days?: number | null
          expires_at?: string | null
          id?: never
          renewal_price_cents?: number | null
          starts_at?: string
          territories?: string[] | null
          usage_scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "rights_grant_collaboration_id_fkey"
            columns: ["collaboration_id"]
            isOneToOne: false
            referencedRelation: "collaboration"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_post: {
        Row: {
          appeal_deadline_at: string | null
          brief_id: number | null
          caption: string | null
          competitor_inspiration_id: number | null
          created_at: string
          disclosure_region: string | null
          disclosure_type: string
          disclosure_verified: boolean
          fail_reason: string | null
          id: number
          idempotency_key: string | null
          owned_account_id: number
          privacy_level: string | null
          publicaly_available_post_id: string | null
          publish_id: string | null
          published_at: string | null
          scheduled_for: string
          sound_id: string | null
          sound_is_cml: boolean | null
          source_brief_id: number | null
          spam_risk_code: string | null
          status: string
          tiktok_disclosure_toggle: string | null
          video_asset_url: string | null
        }
        Insert: {
          appeal_deadline_at?: string | null
          brief_id?: number | null
          caption?: string | null
          competitor_inspiration_id?: number | null
          created_at?: string
          disclosure_region?: string | null
          disclosure_type?: string
          disclosure_verified?: boolean
          fail_reason?: string | null
          id?: never
          idempotency_key?: string | null
          owned_account_id: number
          privacy_level?: string | null
          publicaly_available_post_id?: string | null
          publish_id?: string | null
          published_at?: string | null
          scheduled_for: string
          sound_id?: string | null
          sound_is_cml?: boolean | null
          source_brief_id?: number | null
          spam_risk_code?: string | null
          status?: string
          tiktok_disclosure_toggle?: string | null
          video_asset_url?: string | null
        }
        Update: {
          appeal_deadline_at?: string | null
          brief_id?: number | null
          caption?: string | null
          competitor_inspiration_id?: number | null
          created_at?: string
          disclosure_region?: string | null
          disclosure_type?: string
          disclosure_verified?: boolean
          fail_reason?: string | null
          id?: never
          idempotency_key?: string | null
          owned_account_id?: number
          privacy_level?: string | null
          publicaly_available_post_id?: string | null
          publish_id?: string | null
          published_at?: string | null
          scheduled_for?: string
          sound_id?: string | null
          sound_is_cml?: boolean | null
          source_brief_id?: number | null
          spam_risk_code?: string | null
          status?: string
          tiktok_disclosure_toggle?: string | null
          video_asset_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_post_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "brief"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_post_competitor_inspiration_id_fkey"
            columns: ["competitor_inspiration_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_post_owned_account_id_fkey"
            columns: ["owned_account_id"]
            isOneToOne: false
            referencedRelation: "owned_account"
            referencedColumns: ["id"]
          },
        ]
      }
      tracked_term: {
        Row: {
          added_at: string
          due_at: string
          id: number
          is_tracked: boolean
          last_synced_at: string | null
          notes: string | null
          poll_interval_minutes: number
          term: string
          term_type: string
        }
        Insert: {
          added_at?: string
          due_at?: string
          id?: never
          is_tracked?: boolean
          last_synced_at?: string | null
          notes?: string | null
          poll_interval_minutes?: number
          term: string
          term_type: string
        }
        Update: {
          added_at?: string
          due_at?: string
          id?: never
          is_tracked?: boolean
          last_synced_at?: string | null
          notes?: string | null
          poll_interval_minutes?: number
          term?: string
          term_type?: string
        }
        Relationships: []
      }
      tracked_video: {
        Row: {
          competitor_account_id: number
          created_at_tiktok: string
          description: string | null
          due_at: string
          duration_s: number | null
          first_seen_at: string
          hashtags: string[]
          id: number
          music_id: string | null
          platform_video_id: string
          poll_tier: number
          tracking_active: boolean
        }
        Insert: {
          competitor_account_id: number
          created_at_tiktok: string
          description?: string | null
          due_at?: string
          duration_s?: number | null
          first_seen_at?: string
          hashtags?: string[]
          id?: never
          music_id?: string | null
          platform_video_id: string
          poll_tier?: number
          tracking_active?: boolean
        }
        Update: {
          competitor_account_id?: number
          created_at_tiktok?: string
          description?: string | null
          due_at?: string
          duration_s?: number | null
          first_seen_at?: string
          hashtags?: string[]
          id?: never
          music_id?: string | null
          platform_video_id?: string
          poll_tier?: number
          tracking_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "tracked_video_competitor_account_id_fkey"
            columns: ["competitor_account_id"]
            isOneToOne: false
            referencedRelation: "competitor_account"
            referencedColumns: ["id"]
          },
        ]
      }
      video_analysis: {
        Row: {
          analysed_at: string
          analysis_errors: string[] | null
          audio_type: string | null
          caption_style: string | null
          cost_usd: number | null
          cut_count_first_3s: number | null
          duplicate_of_video_id: number | null
          embedding: unknown
          face_present: boolean | null
          face_screen_fraction: number | null
          format_cluster_id: number | null
          format_summary: string | null
          hook_text_sequence: Json | null
          hook_type: string | null
          model_version: string
          phash_frames: string | null
          spoken_hook: string | null
          spoken_hook_words: Json | null
          transcript: string | null
          video_id: number
        }
        Insert: {
          analysed_at?: string
          analysis_errors?: string[] | null
          audio_type?: string | null
          caption_style?: string | null
          cost_usd?: number | null
          cut_count_first_3s?: number | null
          duplicate_of_video_id?: number | null
          embedding?: unknown
          face_present?: boolean | null
          face_screen_fraction?: number | null
          format_cluster_id?: number | null
          format_summary?: string | null
          hook_text_sequence?: Json | null
          hook_type?: string | null
          model_version: string
          phash_frames?: string | null
          spoken_hook?: string | null
          spoken_hook_words?: Json | null
          transcript?: string | null
          video_id: number
        }
        Update: {
          analysed_at?: string
          analysis_errors?: string[] | null
          audio_type?: string | null
          caption_style?: string | null
          cost_usd?: number | null
          cut_count_first_3s?: number | null
          duplicate_of_video_id?: number | null
          embedding?: unknown
          face_present?: boolean | null
          face_screen_fraction?: number | null
          format_cluster_id?: number | null
          format_summary?: string | null
          hook_text_sequence?: Json | null
          hook_type?: string | null
          model_version?: string
          phash_frames?: string | null
          spoken_hook?: string | null
          spoken_hook_words?: Json | null
          transcript?: string | null
          video_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "video_analysis_duplicate_of_video_id_fkey"
            columns: ["duplicate_of_video_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_analysis_format_cluster_fk"
            columns: ["format_cluster_id"]
            isOneToOne: false
            referencedRelation: "format_cluster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_analysis_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: true
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      video_metric_snapshot: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "video_metric_snapshot_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      video_metric_snapshot_2026_08: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: []
      }
      video_metric_snapshot_2026_09: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: []
      }
      video_metric_snapshot_2026_10: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: []
      }
      video_metric_snapshot_2026_11: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: []
      }
      video_metric_snapshot_2026_12: {
        Row: {
          comment_count: number
          favorites_count: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Insert: {
          comment_count: number
          favorites_count?: number | null
          like_count: number
          share_count: number
          ts: string
          video_id: number
          view_count: number
        }
        Update: {
          comment_count?: number
          favorites_count?: number | null
          like_count?: number
          share_count?: number
          ts?: string
          video_id?: number
          view_count?: number
        }
        Relationships: []
      }
      video_score: {
        Row: {
          acceleration: number | null
          age_hours: number
          baseline_n: number
          computed_at: string
          multiplier_vs_median: number | null
          velocity_vph: number | null
          video_id: number
          z_score: number | null
        }
        Insert: {
          acceleration?: number | null
          age_hours: number
          baseline_n: number
          computed_at?: string
          multiplier_vs_median?: number | null
          velocity_vph?: number | null
          video_id: number
          z_score?: number | null
        }
        Update: {
          acceleration?: number | null
          age_hours?: number
          baseline_n?: number
          computed_at?: string
          multiplier_vs_median?: number | null
          velocity_vph?: number | null
          video_id?: number
          z_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "video_score_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "tracked_video"
            referencedColumns: ["id"]
          },
        ]
      }
      vision_batch_job: {
        Row: {
          cost_usd: number | null
          expires_at: string
          id: string
          resubmit_of: string | null
          status: string
          submitted_at: string
          video_ids: number[]
        }
        Insert: {
          cost_usd?: number | null
          expires_at: string
          id: string
          resubmit_of?: string | null
          status?: string
          submitted_at?: string
          video_ids: number[]
        }
        Update: {
          cost_usd?: number | null
          expires_at?: string
          id?: string
          resubmit_of?: string | null
          status?: string
          submitted_at?: string
          video_ids?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "vision_batch_job_resubmit_of_fkey"
            columns: ["resubmit_of"]
            isOneToOne: false
            referencedRelation: "vision_batch_job"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ensure_metric_partitions: {
        Args: { months_ahead?: number }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
