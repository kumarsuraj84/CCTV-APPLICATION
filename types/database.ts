
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "admin_audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"created_at": string,"detail": NonNullable<Json>,"entity_id": string | null,"entity_type": string | null,"id": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"org_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "admin_audit_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"cameras": {
                  Row: {
                    "camera_ip": string | null,"channel": number,"created_at": string,"id": string,"is_active": boolean,"name": string,"org_id": string,"store_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_ip"?: string | null,"channel": number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"org_id": string,"store_id": string,"updated_at"?: string
                  }
                  Update: {
                    "camera_ip"?: string | null,"channel"?: number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"org_id"?: string,"store_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cameras_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"check_state": {
                  Row: {
                    "consecutive_failures": number,"created_at": string,"down_since": string | null,"error": string | null,"first_failure_at": string | null,"id": string,"last_checked_at": string | null,"last_up_at": string | null,"method": string | null,"org_id": string,"status": string,"target_id": string,"target_type": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "consecutive_failures"?: number,"created_at"?: string,"down_since"?: string | null,"error"?: string | null,"first_failure_at"?: string | null,"id"?: string,"last_checked_at"?: string | null,"last_up_at"?: string | null,"method"?: string | null,"org_id": string,"status"?: string,"target_id": string,"target_type": string,"updated_at"?: string
                  }
                  Update: {
                    "consecutive_failures"?: number,"created_at"?: string,"down_since"?: string | null,"error"?: string | null,"first_failure_at"?: string | null,"id"?: string,"last_checked_at"?: string | null,"last_up_at"?: string | null,"method"?: string | null,"org_id"?: string,"status"?: string,"target_id"?: string,"target_type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "check_state_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"devices": {
                  Row: {
                    "created_at": string,"enabled": boolean,"id": string,"ip": string,"name": string,"notes": string | null,"org_id": string,"store_id": string | null,"tcp_port": number | null,"type": Database["public"]['Enums']["device_type"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"id"?: string,"ip": string,"name": string,"notes"?: string | null,"org_id": string,"store_id"?: string | null,"tcp_port"?: number | null,"type": Database["public"]['Enums']["device_type"],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"id"?: string,"ip"?: string,"name"?: string,"notes"?: string | null,"org_id"?: string,"store_id"?: string | null,"tcp_port"?: number | null,"type"?: Database["public"]['Enums']["device_type"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "devices_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "devices_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "devices_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"monitor_gaps": {
                  Row: {
                    "ended_at": string,"id": string,"started_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ended_at": string,"id"?: string,"started_at": string
                  }
                  Update: {
                    "ended_at"?: string,"id"?: string,"started_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"organizations": {
                  Row: {
                    "created_at": string,"id": string,"is_owner": boolean,"name": string,"slug": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_owner"?: boolean,"name": string,"slug": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_owner"?: boolean,"name"?: string,"slug"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outages": {
                  Row: {
                    "cause": string | null,"created_at": string,"ended_at": string | null,"id": string,"org_id": string,"started_at": string,"target_id": string,"target_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cause"?: string | null,"created_at"?: string,"ended_at"?: string | null,"id"?: string,"org_id": string,"started_at": string,"target_id": string,"target_type": string
                  }
                  Update: {
                    "cause"?: string | null,"created_at"?: string,"ended_at"?: string | null,"id"?: string,"org_id"?: string,"started_at"?: string,"target_id"?: string,"target_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outages_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"email": string,"full_name": string,"id": string,"is_active": boolean,"must_reset_password": boolean,"org_id": string,"role": Database["public"]['Enums']["user_role"],"store_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email": string,"full_name"?: string,"id": string,"is_active"?: boolean,"must_reset_password"?: boolean,"org_id": string,"role"?: Database["public"]['Enums']["user_role"],"store_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"email"?: string,"full_name"?: string,"id"?: string,"is_active"?: boolean,"must_reset_password"?: boolean,"org_id"?: string,"role"?: Database["public"]['Enums']["user_role"],"store_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profiles_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "profiles_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"stores": {
                  Row: {
                    "address": string | null,"city": string | null,"code": string,"created_at": string,"expected_channels": number,"http_port": number,"id": string,"is_active": boolean,"name": string,"nvr_ip": string,"nvr_secret_id": string | null,"nvr_username": string,"org_id": string,"rtsp_port": number,"state": string | null,"updated_at": string,"zone": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"code": string,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id"?: string,"is_active"?: boolean,"name": string,"nvr_ip": string,"nvr_secret_id"?: string | null,"nvr_username": string,"org_id": string,"rtsp_port"?: number,"state"?: string | null,"updated_at"?: string,"zone"?: string | null
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"code"?: string,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id"?: string,"is_active"?: boolean,"name"?: string,"nvr_ip"?: string,"nvr_secret_id"?: string | null,"nvr_username"?: string,"org_id"?: string,"rtsp_port"?: number,"state"?: string | null,"updated_at"?: string,"zone"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"user_camera_access": {
                  Row: {
                    "camera_id": string,"org_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_id": string,"org_id": string,"user_id": string
                  }
                  Update: {
                    "camera_id"?: string,"org_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_camera_access_camera_id_org_id_fkey"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "cameras"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "user_camera_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_camera_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"user_store_access": {
                  Row: {
                    "org_id": string,"store_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"store_id": string,"user_id": string
                  }
                  Update: {
                    "org_id"?: string,"store_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_store_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "user_store_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"user_zone_access": {
                  Row: {
                    "org_id": string,"user_id": string,"zone": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"user_id": string,"zone": string
                  }
                  Update: {
                    "org_id"?: string,"user_id"?: string,"zone"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_zone_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_zone_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"worker_state": {
                  Row: {
                    "check_requested_at": string | null,"id": number,"last_cameras_round_at": string | null,"last_devices_round_at": string | null,"last_heartbeat": string | null,"progress_done": number,"progress_total": number,"run_finished_at": string | null,"run_started_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "check_requested_at"?: string | null,"id": number,"last_cameras_round_at"?: string | null,"last_devices_round_at"?: string | null,"last_heartbeat"?: string | null,"progress_done"?: number,"progress_total"?: number,"run_finished_at"?: string | null,"run_started_at"?: string | null
                  }
                  Update: {
                    "check_requested_at"?: string | null,"id"?: number,"last_cameras_round_at"?: string | null,"last_devices_round_at"?: string | null,"last_heartbeat"?: string | null,"progress_done"?: number,"progress_total"?: number,"run_finished_at"?: string | null,"run_started_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "store_status": {
                  Row: {
                    "cameras_down": number | null,"cameras_live": number | null,"cameras_stale": number | null,"cameras_total": number | null,"cameras_unknown": number | null,"nvr_checked_at": string | null,"nvr_down_since": string | null,"nvr_stale": boolean | null,"nvr_status": string | null,"org_id": string | null,"store_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "current_org_id":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"current_user_role":
{ Args: Record<PropertyKey, never>; Returns: Database["public"]['Enums']["user_role"]
                           },
"granted_store_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"is_staff_all":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"monitor_apply_results":
{ Args: { "p_org": string,"p_results": Json,"p_threshold"?: number }; Returns: undefined
                           },
"monitor_request_check":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"monitor_stale_after_minutes":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"monitor_stop_targets":
{ Args: { "p_ids": (string)[],"p_org": string,"p_type": string }; Returns: undefined
                           },
"nvr_delete_credential":
{ Args: { "p_store": string }; Returns: undefined
                           },
"nvr_read_credential":
{ Args: { "p_store": string }; Returns: string
                           },
"nvr_store_credential":
{ Args: { "p_secret": string,"p_store": string }; Returns: string
                           },
"privilege_violations":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"replace_user_access":
{ Args: { "p_cameras": (string)[],"p_stores": (string)[],"p_user": string,"p_zones": (string)[] }; Returns: undefined
                           },
"revoke_user_sessions":
{ Args: { "p_user": string }; Returns: undefined
                           },
"targets_uptime":
{ Args: { "p_ids": (string)[],"p_now"?: string,"p_org": string,"p_type": string,"p_window": string }; Returns: {
              "target_id": string,"uptime_pct": number
            }[]
                           },
"visible_camera_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"visible_device_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"visible_store_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           }
          }
          Enums: {
            "device_type": "nvr"|"server"|"attendance"|"footfall"|"other","user_role": "user"|"agent"|"manager"|"admin"|"platform_owner"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "device_type": ["nvr", "server", "attendance", "footfall", "other"],"user_role": ["user", "agent", "manager", "admin", "platform_owner"]
          }
        }
} as const
